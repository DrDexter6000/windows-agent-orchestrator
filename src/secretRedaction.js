import { StringDecoder } from "node:string_decoder";

const SECRET_ENV_NAME = /(?:API[_-]?KEY|AUTH[_-]?TOKEN|ACCESS[_-]?TOKEN|(?:^|[_-])TOKEN(?:$|[_-])|SECRET|PASSWORD|PRIVATE[_-]?KEY|CREDENTIAL|(?:HTTP|HTTPS|ALL)_PROXY)/i;
const MIN_SECRET_LENGTH = 8;

export function isSecretEnvName(name) {
  return typeof name === "string" && SECRET_ENV_NAME.test(name);
}

// 决定 0069：命令原文面向 Lead 给出之后，在"环境里按名字识别出的密钥值"之外再
// 兜一层形状——命令行里的内联赋值（名字命中密钥名规则、值不短于 8 字符）与几种
// 常见令牌形状。只是兜底：没有形状的秘密不在覆盖范围内。
const SECRET_TOKEN_SHAPES = [
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}/g, // sk-… 风格的 API key
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub token
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, // JWT
];
const BEARER_SHAPE = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/g;
const INLINE_SECRET_ASSIGNMENT =
  /\b([A-Za-z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*\s*[=:]\s*)("[^"]{8,}"|'[^']{8,}'|[^\s"';&|]{8,})/gi;

export function redactSecretShapes(text) {
  if (typeof text !== "string" || text.length === 0) return text;
  let out = text.replace(INLINE_SECRET_ASSIGNMENT, "$1[REDACTED]").replace(BEARER_SHAPE, "$1[REDACTED]");
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
