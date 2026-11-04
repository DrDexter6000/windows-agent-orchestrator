import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initWaoDir, validateWaoDir, getWaoDir, WAO_TOP_LEVEL_SLOTS } from "../../src/waoDir.js";

async function makeTempDir() {
  return mkdtemp(join(tmpdir(), "wao-dir-"));
}

test("S3-1: initWaoDir 创建 6 必需槽位 + 各 map.md（TD-91 加 pipeline；0094 state 转可选）", async () => {
  const dir = await makeTempDir();
  try {
    await initWaoDir(dir, join(dir, ".wao"), join(dir, ".wao"));
    // 6 个必需槽位都存在
    assert.ok(existsSync(join(dir, ".wao", "project.md")), "project.md 应存在");
    assert.ok(existsSync(join(dir, ".wao", "decisions")), "decisions/ 应存在");
    assert.ok(existsSync(join(dir, ".wao", "pipeline")), "pipeline/ 应存在（TD-91）");
    assert.ok(existsSync(join(dir, ".wao", "handoff")), "handoff/ 应存在");
    assert.ok(existsSync(join(dir, ".wao", "runs")), "runs/ 应存在");
    assert.ok(existsSync(join(dir, ".wao", "migration")), "migration/ 应存在（0045 §4.2）");
    // 可选槽位不预建（0094：state/inbox 由历史布局或 feedback 按需创建）
    assert.ok(!existsSync(join(dir, ".wao", "state")), "state/ 不应被 init 预建（决定 0094）");
    // 各 map.md 存在（decisions/pipeline/handoff 有 map，project.md 是单文件，runs/migration 无 map）
    assert.ok(existsSync(join(dir, ".wao", "decisions", "map.md")), "decisions/map.md 应存在");
    assert.ok(existsSync(join(dir, ".wao", "pipeline", "map.md")), "pipeline/map.md 应存在（TD-91）");
    assert.ok(existsSync(join(dir, ".wao", "handoff", "map.md")), "handoff/map.md 应存在");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S3-1: 已有 state/ 的旧布局 validateWaoDir 仍 ok（0094：state 转可选放行）", async () => {
  const dir = await makeTempDir();
  try {
    await initWaoDir(dir, join(dir, ".wao"), join(dir, ".wao"));
    await mkdir(join(dir, ".wao", "state"), { recursive: true });
    await writeFile(join(dir, ".wao", "state", "current.md"), "");
    const result = validateWaoDir(join(dir, ".wao"), join(dir, ".wao"));
    assert.ok(result.ok, "带可选 state/ 的旧布局应放行");
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.unexpected, [], "state/ 不算多余文件");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S3-1: initWaoDir 幂等（重复 init 不破坏已有内容）", async () => {
  const dir = await makeTempDir();
  try {
    await initWaoDir(dir, join(dir, ".wao"), join(dir, ".wao"));
    // 写一条已有内容（模拟用户已用了）
    await writeFile(join(dir, ".wao", "decisions", "0001-test.md"), "existing decision");
    await writeFile(join(dir, ".wao", "decisions", "map.md"), "0001 | test | existing\n");
    // 重复 init
    await initWaoDir(dir, join(dir, ".wao"), join(dir, ".wao"));
    // 已有内容不丢
    const content = await readFile(join(dir, ".wao", "decisions", "0001-test.md"), "utf8");
    assert.equal(content, "existing decision", "重复 init 不应破坏已有决策");
    const map = await readFile(join(dir, ".wao", "decisions", "map.md"), "utf8");
    assert.ok(map.includes("0001 | test"), "重复 init 不应清空已有 map");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S3-1: initWaoDir 追加 .wao/ 规则到 .gitignore（含 decisions/ 例外，不重复追加）", async () => {
  const dir = await makeTempDir();
  try {
    // 首次 init
    await initWaoDir(dir, join(dir, ".wao"), join(dir, ".wao"));
    let gitignore = await readFile(join(dir, ".gitignore"), "utf8");
    // TD-94（#2 复盘）：应写三行规则——.wao/* 忽略全部 + !.wao/decisions/ 例外入库
    // 不能只写裸 .wao/（会连 decisions/ ADR 一起忽略，违背 SKILL 契约）
    assert.ok(gitignore.includes(".wao/*"), "init 应写 .wao/*（忽略全部）");
    assert.ok(gitignore.includes("!.wao/decisions/"), "init 应写 !.wao/decisions/（ADR 例外入库）");
    // 重复 init 不应重复追加（幂等）
    await initWaoDir(dir, join(dir, ".wao"), join(dir, ".wao"));
    gitignore = await readFile(join(dir, ".gitignore"), "utf8");
    const exceptionMatches = gitignore.match(/!\/?\.wao\/decisions\//g) ?? [];
    assert.equal(exceptionMatches.length, 1, "重复 init 不应重复追加 !.wao/decisions/");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S3-1: validateWaoDir 检测缺失槽位 + 多余文件", async () => {
  const dir = await makeTempDir();
  try {
    // 合法 init
    await initWaoDir(dir, join(dir, ".wao"), join(dir, ".wao"));
    let result = validateWaoDir(join(dir, ".wao"), join(dir, ".wao"));
    assert.ok(result.ok, "合法 init 后 validate 应 ok");
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.unexpected, []);

    // 加一个非法文件
    await writeFile(join(dir, ".wao", "rogue-doc.md"), "should not be here");
    result = validateWaoDir(join(dir, ".wao"), join(dir, ".wao"));
    assert.ok(!result.ok, "有多余文件应不 ok");
    assert.ok(result.unexpected.includes("rogue-doc.md"), "应报出非法文件");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S3-1: validateWaoDir 对未 init 的目录返回 not initialized", async () => {
  const dir = await makeTempDir();
  try {
    const result = validateWaoDir(join(dir, ".wao"), join(dir, ".wao"));
    assert.ok(!result.ok, "未 init 应不 ok");
    assert.equal(result.initialized, false, "应标 initialized=false");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S3-1: getWaoDir 支持 --state-dir 覆盖", () => {
  // 默认 .wao（用 endsWith 避免跨平台盘符/分隔符差异）
  assert.ok(getWaoDir("proj", undefined).endsWith(join(".wao")) || getWaoDir("proj", undefined).endsWith(".wao"));
  // 覆盖
  const custom = getWaoDir("proj", ".custom-wao");
  assert.ok(custom.endsWith(".custom-wao"), `应支持覆盖，got ${custom}`);
});

test("S3-1: WAO_TOP_LEVEL_SLOTS 导出预定义 6 必需槽位（TD-91 pipeline；0045 §4.2 migration；0094 state 转可选）", () => {
  assert.ok(Array.isArray(WAO_TOP_LEVEL_SLOTS));
  assert.ok(WAO_TOP_LEVEL_SLOTS.length === 6, "应正好 6 个必需槽位（0094：state 移出必需集）");
  for (const slot of ["project.md", "decisions", "pipeline", "handoff", "runs", "migration"]) {
    assert.ok(WAO_TOP_LEVEL_SLOTS.includes(slot), `应含 ${slot}`);
  }
  assert.ok(!WAO_TOP_LEVEL_SLOTS.includes("state"), "state 不在必需槽位（决定 0094）");
});

// ===== 决定 0111：getWaoStateDir（显式 --state-dir 不重定向；配置只给名字；链接工作树重定向）=====

import { getWaoStateDir } from "../../src/waoDir.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

test("0111: getWaoStateDir 显式 --state-dir 非空时按 cwd 解析、不重定向（链接工作树形状也不重定向）", async () => {
  const dir = await makeTempDir();
  try {
    // 真文件形状的"伪链接工作树"（.git 文件 + admin/commondir）：显式值下不该被读到。
    mkdirSync(join(dir, "wt"), { recursive: true });
    writeFileSync(join(dir, "wt", ".git"), `gitdir: ${join(dir, "admin").replace(/\\/g, "/")}\n`, "utf8");
    mkdirSync(join(dir, "admin"), { recursive: true });
    writeFileSync(join(dir, "admin", "commondir"), "../proj/.git\n", "utf8");
    mkdirSync(join(dir, "proj", ".git"), { recursive: true });
    assert.equal(getWaoStateDir(join(dir, "wt"), { explicit: ".wao" }), resolve(join(dir, "wt"), ".wao"));
    assert.equal(getWaoStateDir(join(dir, "wt"), { explicit: "sub/state" }), resolve(join(dir, "wt"), "sub/state"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("0111: getWaoStateDir 只有配置名（或全缺省）时用该名字；非链接工作树的 cwd 原样", async () => {
  const dir = await makeTempDir();
  try {
    // readGitFile 不注入=R8 不生效（projectIdentity 的合同）——等价于"读不出照旧"。
    assert.equal(getWaoStateDir(dir, { configured: ".custom-wao" }, {}), resolve(dir, ".custom-wao"));
    assert.equal(getWaoStateDir(dir, {}, {}), resolve(dir, ".wao"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("0111: getWaoStateDir 链接工作树根 → 主工作树同名状态目录（真文件形状，生产 io 读两个小文件）", async () => {
  const dir = await makeTempDir();
  try {
    // 按决定 0099 R8 的 git 读法搭一个真文件形状：wt/.git → gitdir: admin；
    // admin/commondir → ../proj/.git（basename 恰为 .git）→ 主工作树 = dir/proj。
    const main = join(dir, "proj");
    const wt = join(dir, "wt");
    mkdirSync(wt, { recursive: true });
    mkdirSync(join(dir, "admin"), { recursive: true });
    writeFileSync(join(wt, ".git"), `gitdir: ${join(dir, "admin").replace(/\\/g, "/")}\n`, "utf8");
    writeFileSync(join(dir, "admin", "commondir"), "../proj/.git\n", "utf8");
    mkdirSync(main, { recursive: true });
    mkdirSync(join(main, ".git"), { recursive: true });
    assert.equal(getWaoStateDir(wt, {}), resolve(main, ".wao"));
    assert.equal(getWaoStateDir(wt, { configured: ".custom-wao" }), resolve(main, ".custom-wao"));
    // 主工作树自身（.git 是目录不是文件）→ 原样。
    assert.equal(getWaoStateDir(main, {}), resolve(main, ".wao"));
    // 反斜杠输入与尾斜杠同义。
    assert.equal(getWaoStateDir(`${wt}\\`, {}), resolve(main, ".wao"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ===== 决定 0111：initWaoDir/validateWaoDir 两个显式目录 =====

test("0111: initWaoDir 决定目录与状态目录分离——decisions/ 在决定目录，其余槽位在状态目录，.gitignore 仍在 cwd", async () => {
  const dir = await makeTempDir();
  try {
    const decisionsDir = join(dir, "wt", ".wao");
    const stateDir = join(dir, "main", ".wao");
    await initWaoDir(dir, decisionsDir, stateDir);
    assert.ok(existsSync(join(decisionsDir, "decisions", "map.md")), "decisions/ 建在决定目录");
    for (const slot of ["project.md", "pipeline", "handoff", "runs", "migration"]) {
      assert.ok(existsSync(join(stateDir, slot)), `状态槽位 ${slot} 建在状态目录`);
      assert.ok(!existsSync(join(decisionsDir, slot)), `决定目录不应有 ${slot}`);
    }
    assert.ok(existsSync(join(dir, ".gitignore")), ".gitignore 照旧写在 cwd");
    // 分离目录校验：两边齐=ok。
    const ok = validateWaoDir(decisionsDir, stateDir);
    assert.ok(ok.ok, `分离目录齐备应 ok（missing=${ok.missing} unexpected=${ok.unexpected}）`);
    assert.equal(ok.initialized, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("0111: validateWaoDir 分离目录——各边缺槽位/多余文件分开上报；两边都不存在=未初始化", async () => {
  const dir = await makeTempDir();
  try {
    const decisionsDir = join(dir, "wt", ".wao");
    const stateDir = join(dir, "main", ".wao");
    // 两边都不存在 → 未初始化。
    assert.deepEqual(
      validateWaoDir(decisionsDir, stateDir),
      { ok: false, initialized: false, missing: [], unexpected: [] },
    );
    // 决定目录只有 decisions（fresh clone 形状），状态目录不存在 → initialized、
    // 缺 5 个状态槽位（doctor 的 fresh-clone WARN 形状）。
    await mkdir(join(decisionsDir, "decisions"), { recursive: true });
    const half = validateWaoDir(decisionsDir, stateDir);
    assert.equal(half.initialized, true);
    assert.ok(!half.ok);
    assert.deepEqual(half.missing, ["project.md", "pipeline", "handoff", "runs", "migration"]);
    assert.deepEqual(half.unexpected, []);
    // 状态目录出现多余文件 → unexpected 上报。
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "rogue.md"), "x");
    const dirty = validateWaoDir(decisionsDir, stateDir);
    assert.deepEqual(dirty.unexpected, ["rogue.md"]);
    // 决定目录出现多余文件 → 同样上报。
    await writeFile(join(decisionsDir, "rogue2.md"), "x");
    assert.deepEqual(validateWaoDir(decisionsDir, stateDir).unexpected, ["rogue2.md", "rogue.md"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
