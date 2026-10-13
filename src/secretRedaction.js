import { StringDecoder } from "node:string_decoder";

const SECRET_ENV_NAME = /(?:API[_-]?KEY|AUTH[_-]?TOKEN|ACCESS[_-]?TOKEN|(?:^|[_-])TOKEN(?:$|[_-])|SECRET|PASSWORD|PRIVATE[_-]?KEY|CREDENTIAL|(?:HTTP|HTTPS|ALL)_PROXY)/i;
const MIN_SECRET_LENGTH = 8;

export function isSecretEnvName(name) {
  return typeof name === "string" && SECRET_ENV_NAME.test(name);
}

// 决定 0069：命令原文面向 Lead 给出之后，在"环境里按名字识别出的密钥值"之外再
// 兜一层形状——命令行里的内联赋值（名字命中密钥名规则、值不短于 8 字符）与几种
// 常见令牌形状。只是兜底：没有形状的秘密不在覆盖范围内。
// 密钥名规则命中的赋值：NAME=值 / NAME: 值 / "name": "值" / $env:NAME="值"。引号内
// 允许转义引号——整段值被替换，不留尾巴。名字两侧的字符数有上界（{0,40}）：这些规则
// 现在也作用在几百 KB 的工具输出上，无界的 * 在一长串字母数字（base64 块）上是平方级。
const INLINE_SECRET_ASSIGNMENT =
  /((?:\$env:)?["']?[A-Za-z0-9_.-]{0,40}(?:API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]{0,40}["']?\s*[=:]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s"';&|,}]{8,})/gi;
// 命令行参数：--api-key 值 / --token=值（空格或等号分隔）。
const FLAG_SECRET =
  /(--?[A-Za-z0-9-]{0,40}(?:api-?key|access-?key|private-?key|token|secret|password|passwd|credential)[A-Za-z0-9-]{0,40}(?:\s+|=))("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s"';&|]{8,})/gi;
// Authorization 头里方案词后面的凭证；Bearer 单独出现也算（大小写不敏感）。Basic /
// Token 只在 Authorization 语境里算——否则 "token <某个词>" 这样的普通文字会被误伤。
const AUTH_SCHEME = /\b(Authorization["']?\s*[:=]\s*["']?(?:Bearer|Basic|Token)\s+|Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
// URL 里的 user:pass@、curl 的 -u user:pass——只遮口令那一段。
const URL_USERINFO = /(:\/\/[^\s\/:@]+:)[^\s\/@]+(@)/g;
const CURL_USER = /((?:-u|--user)\s+["']?[^\s:"']+:)[^\s"']+/g;
// PEM 私钥块（到 END 行或文本结尾）。
const PEM_PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const SECRET_TOKEN_SHAPES = [
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google API key
  /\bnpm_[A-Za-z0-9]{30,}/g, // npm token
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}/g, // sk-… 风格的 API key
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub token
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained token
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack token
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, // JWT
];

const PEM_END_LINE = /-----END [A-Z ]*PRIVATE KEY-----/;
const BASE64_LINE = /^[A-Za-z0-9+/=]{16,}$/;

// 只见 END 不见 BEGIN（文本是私钥块的后半段，例如 tail 出来的）：把 END 行之前连续
// 的 base64 行连同 END 行一起遮掉。逐行扫描，线性。
function redactOrphanPemTails(text) {
  if (!text.includes("PRIVATE KEY-----")) return text;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (!PEM_END_LINE.test(lines[i])) continue;
    let from = i;
    while (from > 0 && BASE64_LINE.test(lines[from - 1].trim())) from -= 1;
    if (from === i) continue;
    lines.splice(from, i - from + 1, "[REDACTED]");
    i = from;
  }
  return lines.join("\n");
}

// 调用方先做环境密钥值的整段替换，再过这一层——反过来的话，形状替换会把环境值
// 切碎，整段匹配随之失效，尾巴漏出（会审 sol 的反例）。
export function redactSecretShapes(text) {
  if (typeof text !== "string" || text.length === 0) return text;
  let out = redactOrphanPemTails(text
    .replace(INLINE_SECRET_ASSIGNMENT, "$1[REDACTED]")
    .replace(FLAG_SECRET, "$1[REDACTED]")
    .replace(AUTH_SCHEME, "$1[REDACTED]")
    .replace(URL_USERINFO, "$1[REDACTED]$2")
    .replace(CURL_USER, "$1[REDACTED]")
    .replace(PEM_PRIVATE_KEY, "[REDACTED]"));
  for (const shape of SECRET_TOKEN_SHAPES) out = out.replace(shape, "[REDACTED]");
  return out;
}

export function createSecretRedactor(env = process.env, additionalNames = []) {
  const explicitNames = new Set(additionalNames.map((name) => String(name).toUpperCase()));
  const byValue = new Map();
  for (const [name, rawValue] of Object.entries(env ?? {})) {
    const explicit = explicitNames.has(name.toUpperCase());
    if ((!isSecretEnvName(name) && !explicit) || typeof rawValue !== "string") continue;
    if ((!explicit && rawValue.length < MIN_SECRET_LENGTH) || rawValue.length === 0) continue;
    if (!byValue.has(rawValue)) byValue.set(rawValue, name);
  }
  const entries = [...byValue.entries()]
    .map(([value, name]) => ({ value, marker: `[REDACTED:${name}]` }))
    .sort((a, b) => b.value.length - a.value.length);

  const redactString = (value) => {
    let output = String(value);
    for (const entry of entries) output = output.split(entry.value).join(entry.marker);
    return output;
  };

  return {
    entries,
    redact: (value) => redactValue(value, redactString),
    redactString,
    createStream: () => new SecretStreamRedactor(entries),
  };
}

function redactValue(value, redactString) {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, redactString));
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = redactValue(item, redactString);
  }
  return output;
}

class SecretStreamRedactor {
  constructor(entries) {
    this.entries = entries;
    this.maxLength = entries.reduce((max, entry) => Math.max(max, entry.value.length), 0);
    this.pending = "";
    this.decoder = new StringDecoder("utf8");
  }

  write(chunk) {
    this.pending += Buffer.isBuffer(chunk) ? this.decoder.write(chunk) : String(chunk);
    return this._drain(false);
  }

  end() {
    this.pending += this.decoder.end();
    return this._drain(true);
  }

  _drain(final) {
    if (this.entries.length === 0) {
      const output = this.pending;
      this.pending = "";
      return output;
    }
    let output = "";
    while (this.pending.length > 0 && (final || this.pending.length >= this.maxLength)) {
      const match = this.entries.find((entry) => this.pending.startsWith(entry.value));
      if (match) {
        output += match.marker;
        this.pending = this.pending.slice(match.value.length);
      } else {
        output += this.pending[0];
        this.pending = this.pending.slice(1);
      }
    }
    return output;
  }
}
