// test/run-lifecycle/claudeOauthDoctorCheck.test.js
//
// TD-223（2026-10-07）：wao doctor 的 claude_oauth_temp_dirs advisory 检查。
//
// 契约：复用 application/oauthDirSweep.js 的 dry-run 报数（判定规则单一实现）；
// 有 wao-claude-oauth-* 目录才出现条目；可清理数 >0 → WARN（附 sweep 指引 fix），
// 仅活 run 目录 → INFO；doctor 永不执行删除（本文件头部铁律，测试钉死）。
//
// 隔离：os.tmpdir() 按 TEMP/TMP/TMPDIR env 解析——测试期间把三者指向 fixture
// 根，doctor 扫的是 fixture 而非机器真实 %TEMP%（不数真实目录、绝不真删）。

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { waoDoctorCommand } from "../../src/commands/doctor.js";
import { OAUTH_DIR_PREFIX, OWNER_MARKER_FILE, SWEEP_LEGACY_AGE_MS } from "../../src/application/oauthDirSweep.js";

async function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "wao-td223-doctor-"));
}

// 临时改写 tmpdir 解析（Windows: TEMP/TMP；POSIX: TMPDIR），返回恢复函数。
function redirectTmp(target) {
  const keys = ["TEMP", "TMP", "TMPDIR"];
  const saved = keys.map((k) => [k, process.env[k]]);
  for (const k of keys) process.env[k] = target;
  return () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

// 捕获 console.log（doctor 全部输出走它），返回 [lines, restore]。
function captureConsole() {
  const original = console.log;
  const lines = [];
  console.log = (...args) => { lines.push(args.map(String).join(" ")); };
  return [lines, () => { console.log = original; }];
}

// 以 --format json 跑 doctor 并解析 checks（fix 字段只在 json 面暴露）。
async function doctorChecks(root, args = []) {
  const [lines, restoreConsole] = captureConsole();
  try {
    await waoDoctorCommand(args, {
      registry: join(root, "agents.json"), // 缺席 → registry INFO 路径
      stateDir: join(root, "wao"),
      runDir: join(root, "runs"),
    });
  } finally {
    restoreConsole();
  }
  const jsonLine = lines.find((l) => l.trimStart().startsWith("{"));
  assert.ok(jsonLine, "doctor json 输出在场");
  const parsed = JSON.parse(jsonLine);
  return { checks: parsed.checks, lines };
}

test("TD-223 doctor: 有可清理目录 → WARN 条目 + sweep 指引 fix；dry-run 不删任何目录", async () => {
  const root = await makeTempDir();
  const restoreTmp = redirectTmp(root);
  try {
    // fixture：1 个超龄遗留（可清理）+ 1 个 owner-alive（本进程 pid）+ 1 个无前缀目录。
    const old = join(root, `${OAUTH_DIR_PREFIX}legacy`);
    mkdirSync(old);
    const now = Date.now();
    utimesSync(old, new Date(now - SWEEP_LEGACY_AGE_MS * 2), new Date(now - SWEEP_LEGACY_AGE_MS * 2));
    const alive = join(root, `${OAUTH_DIR_PREFIX}alive`);
    mkdirSync(alive);
    writeFileSync(join(alive, OWNER_MARKER_FILE), JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), "utf8");
    const unrelated = join(root, "unrelated");
    mkdirSync(unrelated);

    const { checks } = await doctorChecks(root, ["--format", "json"]);
    const check = checks.find((c) => c.name === "claude_oauth_temp_dirs");
    assert.ok(check, "出现 claude_oauth_temp_dirs 检查条目");
    assert.equal(check.status, "warn", "有可清理目录时是 WARN（卫生债）");
    assert.ok(check.detail.includes("2 个"), `报数扫描到 2 个前缀目录：${check.detail}`);
    assert.ok(check.detail.includes("可清理 1"), "可清理数 = 1（超龄遗留）");
    assert.equal(
      check.fix,
      "npm run cli -- wao sweep-claude-config --apply（先不带 --apply 看清单）",
      "fix 给出 sweep 指引",
    );

    // 铁律：doctor 永不执行删除。
    assert.ok(existsSync(old) && existsSync(alive) && existsSync(unrelated), "dry-run 零删除");
  } finally {
    restoreTmp();
    rmSync(root, { recursive: true, force: true });
  }
});

test("TD-223 doctor: 零前缀目录 → 不产生条目（健康面无噪音，budget_* 惯例）", async () => {
  const root = await makeTempDir();
  const restoreTmp = redirectTmp(root);
  try {
    mkdirSync(join(root, "unrelated-dir"));
    const { checks } = await doctorChecks(root, ["--format", "json"]);
    assert.ok(
      !checks.some((c) => c.name === "claude_oauth_temp_dirs"),
      "无前缀目录时不出现该检查条目",
    );
  } finally {
    restoreTmp();
    rmSync(root, { recursive: true, force: true });
  }
});

test("TD-223 doctor: 仅活 run 目录 → INFO（不计 DEGRADED 语义，正常在场）", async () => {
  const root = await makeTempDir();
  const restoreTmp = redirectTmp(root);
  try {
    const alive = join(root, `${OAUTH_DIR_PREFIX}alive`);
    mkdirSync(alive);
    writeFileSync(join(alive, OWNER_MARKER_FILE), JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), "utf8");
    const { checks } = await doctorChecks(root, ["--format", "json"]);
    const check = checks.find((c) => c.name === "claude_oauth_temp_dirs");
    assert.ok(check, "有条目（扫描面非零）");
    assert.equal(check.status, "info", "仅活 run 目录 → INFO");
    assert.ok(existsSync(alive), "不删除");
  } finally {
    restoreTmp();
    rmSync(root, { recursive: true, force: true });
  }
});
