#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { options, passthrough } = parseArgs(process.argv.slice(2));

if (passthrough.length === 0) {
  fail("missing Claude Code passthrough args after --");
}
if (!options.baseUrl) {
  fail("missing --base-url");
}
if (!options.apiKeyEnv) {
  fail("missing --api-key-env");
}

const token = process.env[options.apiKeyEnv];
if (!token) {
  fail(`${options.apiKeyEnv} is not set`);
}

const wrapperDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(wrapperDir, "..", "..");
const isolatedClaudeConfigDir = path.join(repoRoot, ".wao-worker-claude-config");
mkdirSync(isolatedClaudeConfigDir, { recursive: true });

const childEnv = {
  ...process.env,
  ANTHROPIC_BASE_URL: options.baseUrl,
  ANTHROPIC_AUTH_TOKEN: token,
  CLAUDE_CONFIG_DIR: isolatedClaudeConfigDir,
};
deleteOAuthHints(childEnv);

if (options.defaultModel) {
  childEnv.ANTHROPIC_MODEL = options.defaultModel;
  childEnv.ANTHROPIC_DEFAULT_OPUS_MODEL = options.defaultModel;
  childEnv.ANTHROPIC_DEFAULT_SONNET_MODEL = options.defaultModel;
  childEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL = options.defaultModel;
  childEnv.CLAUDE_CODE_SUBAGENT_MODEL = options.defaultModel;
}
if (options.contextWindow) {
  childEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW = options.contextWindow;
}
if (options.effort) {
  childEnv.CLAUDE_CODE_EFFORT_LEVEL = options.effort;
}

const binary = resolveBinary(options.claudeBinary ?? "claude");
const child = spawn(binary, passthrough, {
  env: childEnv,
  stdio: "inherit",
  windowsHide: true,
});

child.on("error", (error) => {
  fail(`failed to start ${binary}: ${error.message}`);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

function parseArgs(argv) {
  const marker = argv.indexOf("--");
  if (marker < 0) {
    fail("missing -- separator before Claude Code args");
  }
  const optionArgs = argv.slice(0, marker);
  const passthrough = argv.slice(marker + 1);
  const options = {};

  for (let i = 0; i < optionArgs.length; i += 1) {
    const key = optionArgs[i];
    const value = optionArgs[i + 1];
    if (!key.startsWith("--")) {
      fail(`unexpected argument: ${key}`);
    }
    if (value === undefined || value.startsWith("--")) {
      fail(`${key} requires a value`);
    }
    i += 1;
    switch (key) {
      case "--claude-binary":
        options.claudeBinary = value;
        break;
      case "--base-url":
        options.baseUrl = value;
        break;
      case "--api-key-env":
        options.apiKeyEnv = value;
        break;
      case "--default-model":
        options.defaultModel = value;
        break;
      case "--context-window":
        options.contextWindow = value;
        break;
      case "--effort":
        options.effort = value;
        break;
      default:
        fail(`unknown option: ${key}`);
    }
  }

  return { options, passthrough };
}

function resolveBinary(binary) {
  if (path.isAbsolute(binary) || path.dirname(binary) !== ".") {
    return binary;
  }
  if (process.platform !== "win32") {
    return binary;
  }
  try {
    const out = execFileSync("where.exe", [binary], { encoding: "utf8", windowsHide: true });
    const candidates = out.split(/\r?\n/).filter(Boolean);
    return candidates.find((candidate) => candidate.toLowerCase().endsWith(".exe")) ?? candidates[0] ?? binary;
  } catch {
    return binary;
  }
}

function deleteOAuthHints(env) {
  for (const key of Object.keys(env)) {
    if (key === "CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH" || /^CLAUDE_CODE_.*OAUTH/i.test(key)) {
      delete env[key];
    }
  }
}

function fail(message) {
  console.error(`[claude-code-provider-wrapper] ${message}`);
  process.exit(1);
}
