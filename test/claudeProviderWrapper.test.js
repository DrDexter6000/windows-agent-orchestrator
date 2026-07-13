import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);
const NODE = process.execPath;
const WRAPPER = path.resolve("scripts/wrappers/claude-code-provider-wrapper.mjs");

test("claude provider wrapper forwards angle-bracket prompts without shell reparsing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wao-claude-wrapper-"));
  const fakeClaude = path.join(dir, "fake-claude.mjs");
  await writeFile(fakeClaude, [
    "process.stdout.write(JSON.stringify({",
    "  argv: process.argv.slice(2),",
    "  env: {",
    "    baseUrl: process.env.ANTHROPIC_BASE_URL,",
    "    token: process.env.ANTHROPIC_AUTH_TOKEN,",
    "    sourceToken: process.env.DEEPSEEK_API_KEY,",
    "    model: process.env.ANTHROPIC_MODEL,",
    "    compact: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,",
    "    configDir: process.env.CLAUDE_CONFIG_DIR,",
    "  },",
    "}) + '\\n');",
  ].join("\n"));
  const homeDir = path.join(dir, "home");
  const oauthDir = path.join(homeDir, ".claude");
  await mkdir(oauthDir, { recursive: true });
  await writeFile(path.join(oauthDir, ".credentials.json"), JSON.stringify({
    claudeAiOauth: { accessToken: "oauth-token-that-must-not-be-used" },
  }));

  try {
    const { stdout } = await execFileAsync(NODE, [
      WRAPPER,
      "--claude-binary", NODE,
      "--base-url", "https://api.deepseek.com/anthropic",
      "--api-key-env", "deepseek_api_key",
      "--default-model", "deepseek-v4-flash",
      "--context-window", "200000",
      "--",
      fakeClaude,
      "-p", "Read <sent_a.txt content> and <sent_b.txt content>",
      "--output-format", "stream-json",
    ], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: "test-secret",
        HOME: homeDir,
        USERPROFILE: homeDir,
        CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH: "1",
      },
    });

    const parsed = JSON.parse(stdout);
    assert.deepEqual(parsed.argv, [
      "-p", "Read <sent_a.txt content> and <sent_b.txt content>",
      "--output-format", "stream-json",
    ]);
    assert.equal(parsed.env.baseUrl, "https://api.deepseek.com/anthropic");
    assert.equal(parsed.env.token, "test-secret");
    assert.equal(parsed.env.sourceToken, undefined);
    assert.equal(parsed.env.model, "deepseek-v4-flash");
    assert.equal(parsed.env.compact, "200000");
    assert.ok(parsed.env.configDir, "wrapper must set CLAUDE_CONFIG_DIR for provider workers");
    assert.notEqual(path.resolve(parsed.env.configDir), oauthDir);
    assert.ok(!path.resolve(parsed.env.configDir).startsWith(path.resolve(oauthDir)));
    const configListing = await readFile(path.join(parsed.env.configDir, ".credentials.json"), "utf8").catch(() => "");
    assert.ok(!configListing.includes("claudeAiOauth"), "isolated config dir must not copy OAuth credentials");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("claude provider wrapper preserves ANTHROPIC_AUTH_TOKEN when it is the assigned source channel", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wao-claude-wrapper-token-"));
  const fakeClaude = path.join(dir, "fake-claude.mjs");
  await writeFile(fakeClaude, "process.stdout.write(process.env.ANTHROPIC_AUTH_TOKEN ?? 'missing');");
  try {
    const { stdout } = await execFileAsync(NODE, [
      WRAPPER,
      "--claude-binary", NODE,
      "--base-url", "https://example.invalid/anthropic",
      "--api-key-env", "ANTHROPIC_AUTH_TOKEN",
      "--",
      fakeClaude,
    ], {
      cwd: path.resolve("."),
      env: { ...process.env, ANTHROPIC_AUTH_TOKEN: "test-secret-auth-token" },
    });
    assert.equal(stdout, "test-secret-auth-token");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
