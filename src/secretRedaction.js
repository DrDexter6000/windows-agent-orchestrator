import { StringDecoder } from "node:string_decoder";

const SECRET_ENV_NAME = /(?:API[_-]?KEY|AUTH[_-]?TOKEN|ACCESS[_-]?TOKEN|(?:^|[_-])TOKEN(?:$|[_-])|SECRET|PASSWORD|PRIVATE[_-]?KEY|CREDENTIAL|(?:HTTP|HTTPS|ALL)_PROXY)/i;
const MIN_SECRET_LENGTH = 8;

export function isSecretEnvName(name) {
  return typeof name === "string" && SECRET_ENV_NAME.test(name);
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
