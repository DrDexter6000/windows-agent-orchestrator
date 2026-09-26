// test/process/genSurfaceEntry.test.js
//
// gen-surface「纯库 + 薄入口」拆分的入口回归（TD-185）。
// process 组：真实子进程（spawnSync node），temp 夹具在 os.tmpdir() 下。
//
// 被钉合同：
//   - scripts/gen-surface.mjs 是纯库：只导出 generate() 与 render()，导入零
//     副作用、零入口探测（无 import.meta.main / argv 比对 / realpath-ino 刡定 /
//     process.exit）。旧实现的入口判定（`if (import.meta.main)`）在缺少该属性的
//     Node 22.x 上为 undefined ⇒ 写出分支被静默跳过（exit 0 不写文件，fail-open），
//     由此整体退场；直接 `node scripts/gen-surface.mjs`（含无参）必须零动作。
//   - scripts/gen-surface-cli.mjs 是唯一薄入口：无参＝先完整 generate() 成功再
//     写出两份；恰好 --check ＝只读比对（CRLF/LF 归一化相同，缺失/过期非零且
//     不改文件）；其他任何参数＝非零退出且不生成、不写入、不检查。
//
// 夹具纪律：os.tmpdir() 下建最小仓库副本——cpSync 整个 src/、两个
// scripts/gen-surface*.mjs、建 docs/surface/、最小 package.json（type:module +
// 与真仓一致的 name/version，使 src/mcp/server.js 的
// createRequire("../../package.json").version 解析同形）＋ node_modules junction
// 指向仓库已安装依赖（真实 SDK 渲染，不安装任何东西；不复制整个仓库）。
// CLI 的 REPO_ROOT 从 import.meta.url 派生 ⇒ spawn 的 cwd 用无关目录（不靠 cwd
// 找仓）。夹具与无关 cwd 都放在含空格 + 非 ASCII 字符的目录路径下（Windows 路径
// 形状回归）。断言不只看退出码：逐场景检查真实文件字节与目录副作用。清理复用
// _rmrfHelper.mjs。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { rmrfRetry } from "../_rmrfHelper.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
// 生成器结果键（正斜杠仓库相对路径），同时直接用作 fs 相对路径。
const MCP_KEY = "docs/surface/mcp-tools.md";
const CLI_KEY = "docs/surface/cli.md";
const SPAWN_OPTS = { encoding: "utf8", timeout: 120_000, windowsHide: true };

/**
 * 从 REPO_ROOT 逐级向上找含 @modelcontextprotocol/sdk 的 node_modules（worktree
 * 自身无 node_modules，靠父级真仓解析）；夹具用 junction 复用同一份已装依赖。
 */
function findSdkNodeModules() {
  let dir = REPO_ROOT;
  for (;;) {
    const candidate = join(dir, "node_modules");
    if (existsSync(join(candidate, "@modelcontextprotocol", "sdk"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("genSurfaceEntry fixture: no node_modules with @modelcontextprotocol/sdk found above the repo");
    }
    dir = parent;
  }
}

/**
 * 含空格 + 非 ASCII 字符的夹具家目录（Windows 路径形状回归：空格、CJK、变音符）。
 * 夹具根与无关 cwd 都落在这里。
 */
function buildWeirdHome() {
  const base = mkdtempSync(join(tmpdir(), "wao-surface-entry-"));
  const weird = join(base, "目录 with 空格 + ünicode");
  mkdirSync(weird, { recursive: true });
  assert.match(weird, /\s/, "夹具自检：路径必须含空格");
  assert.match(weird, /[^\x00-\x7f]/, "夹具自检：路径必须含非 ASCII 字符");
  return weird;
}

/**
 * 建 tmp 夹具：src/ + 两个 gen-surface 脚本 + docs/surface/ + 最小 package.json +
 * node_modules junction。
 *
 * 实现注：cpSync 在 Windows Node 22 上对**非 ASCII 目标路径**会把目标根做一次
 * 有损重编码（实测生成「鐩綍 …」乱码孪生目录且不报错），因此复制一律先落在
 * ASCII staging 目录，再用 renameSync 整体搬进含空格 + 非 ASCII 的家目录
 * （mkdirSync/writeFileSync/rmSync/symlinkSync/junction/spawn 对该路径形状均正常）。
 */
function buildFixture(home) {
  const stage = mkdtempSync(join(tmpdir(), "wao-surface-stage-"));
  cpSync(join(REPO_ROOT, "src"), join(stage, "src"), { recursive: true });
  // playbooks/lead 是 src/application/playbookCatalog.js 的加载期必读目录
  // （src/mcp/server.js 的 import 链在模块加载时就校验闭集目录）。
  cpSync(join(REPO_ROOT, "playbooks"), join(stage, "playbooks"), { recursive: true });
  mkdirSync(join(stage, "scripts"), { recursive: true });
  cpSync(join(REPO_ROOT, "scripts", "gen-surface.mjs"), join(stage, "scripts", "gen-surface.mjs"));
  cpSync(join(REPO_ROOT, "scripts", "gen-surface-cli.mjs"), join(stage, "scripts", "gen-surface-cli.mjs"));
  mkdirSync(join(stage, "docs", "surface"), { recursive: true });
  const repoPkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  writeFileSync(
    join(stage, "package.json"),
    `${JSON.stringify({ name: repoPkg.name, version: repoPkg.version, private: true, type: "module" }, null, 2)}\n`,
    "utf8",
  );
  const root = join(home, "fixture-repo with spaces");
  renameSync(stage, root);
  symlinkSync(findSdkNodeModules(), join(root, "node_modules"), "junction");
  return root;
}

/** 无关 cwd：含空格 + 非 ASCII 的独立目录，既不是夹具、也不是仓，也不是夹具的业务祖先。 */
function buildUnrelatedCwd(home) {
  const cwd = join(home, "unrelated cwd 目录");
  mkdirSync(cwd, { recursive: true });
  return cwd;
}

/** 一次性夹具上下文（home + fixture + 无关 cwd），清理统一走 rmrfRetry(home)。 */
function setup() {
  const home = buildWeirdHome();
  return { home, fixture: buildFixture(home), cwd: buildUnrelatedCwd(home) };
}

/** 夹具内目标文件绝对路径（key 即 generate() 结果键，正斜杠相对路径）。 */
function target(fixtureRoot, key) {
  return join(fixtureRoot, key);
}

/** 真实 spawn 薄入口（canonical 套件下 process.execPath 即 v22 node）。 */
function runCli(cwd, fixtureRoot, args) {
  return spawnSync(
    process.execPath,
    [join(fixtureRoot, "scripts", "gen-surface-cli.mjs"), ...args],
    { cwd, ...SPAWN_OPTS },
  );
}

/** spawn 基线：无 error、无 signal（status 由各场景自己比较）。 */
function assertSpawnClean(r, label) {
  assert.ok(!r.error, `${label}: spawn error = ${r.error}`);
  assert.equal(r.signal, null, `${label}: signal 应为 null`);
}

/** import 夹具纯库拿真实派生结果（夹具 src 是真仓副本，输出逐字节相同）。 */
async function importFixtureLib(fixtureRoot) {
  return import(pathToFileURL(join(fixtureRoot, "scripts", "gen-surface.mjs")).href);
}

// ===== 场景 1：目标缺失 + 无参生成 → 递归建目录并写出两份，内容 == 真实派生结果 =====
test("entry-1: docs/ 整体缺失 + 无参 → 递归建目录写出两份，内容逐字等于 generate() 输出", async () => {
  const { home, fixture, cwd } = setup();
  try {
    rmSync(join(fixture, "docs"), { recursive: true, force: true }); // 连 docs/ 一起删，证明 mkdir -p
    const lib = await importFixtureLib(fixture);
    const expected = await lib.generate();
    const r = runCli(cwd, fixture, []);
    assertSpawnClean(r, "entry-1");
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    for (const key of [MCP_KEY, CLI_KEY]) {
      const file = target(fixture, key);
      assert.ok(existsSync(file), `${key} 应被创建`);
      assert.equal(readFileSync(file, "utf8"), expected[key], `${key} 内容必须逐字等于真实派生结果`);
      assert.match(r.stdout, new RegExp(`wrote ${key}`), `${key} 应有写出声明`);
    }
    for (const [key, content] of Object.entries(expected)) {
      assert.match(
        r.stdout,
        new RegExp(`${key} \\(${Buffer.byteLength(content, "utf8")} bytes\\)`),
        `stdout 应含 ${key} 的真实字节数`,
      );
    }
  } finally {
    rmrfRetry(home);
  }
});

// ===== 场景 2：两份过期 + 无参生成 → 更新正确；再次执行字节不变（幂等） =====
test("entry-2: 目标过期 + 无参 → 更新为派生结果；再跑一次字节不变（幂等）", async () => {
  const { home, fixture, cwd } = setup();
  try {
    writeFileSync(target(fixture, MCP_KEY), "STALE MCP\n", "utf8");
    writeFileSync(target(fixture, CLI_KEY), "STALE CLI\n", "utf8");
    const lib = await importFixtureLib(fixture);
    const expected = await lib.generate();
    const r1 = runCli(cwd, fixture, []);
    assertSpawnClean(r1, "entry-2 first");
    assert.equal(r1.status, 0, `stderr: ${r1.stderr}`);
    assert.equal(readFileSync(target(fixture, MCP_KEY), "utf8"), expected[MCP_KEY], "mcp-tools.md 应被更新");
    assert.equal(readFileSync(target(fixture, CLI_KEY), "utf8"), expected[CLI_KEY], "cli.md 应被更新");
    const beforeMcp = readFileSync(target(fixture, MCP_KEY));
    const beforeCli = readFileSync(target(fixture, CLI_KEY));
    const r2 = runCli(cwd, fixture, []);
    assertSpawnClean(r2, "entry-2 second");
    assert.equal(r2.status, 0, `stderr: ${r2.stderr}`);
    assert.deepEqual(readFileSync(target(fixture, MCP_KEY)), beforeMcp, "幂等：mcp-tools.md 原始字节不变");
    assert.deepEqual(readFileSync(target(fixture, CLI_KEY)), beforeCli, "幂等：cli.md 原始字节不变");
  } finally {
    rmrfRetry(home);
  }
});

// ===== 场景 3：--check 正常（LF）/ CRLF → exit 0，两份原始字节都不动 =====
test("entry-3: --check 对 LF 与 CRLF 磁盘副本均 exit 0，且原始字节不动", async () => {
  const { home, fixture, cwd } = setup();
  try {
    const lib = await importFixtureLib(fixture);
    const expected = await lib.generate();

    // LF 副本（生成器原生换行）。
    writeFileSync(target(fixture, MCP_KEY), expected[MCP_KEY], "utf8");
    writeFileSync(target(fixture, CLI_KEY), expected[CLI_KEY], "utf8");
    const beforeLfMcp = readFileSync(target(fixture, MCP_KEY));
    const beforeLfCli = readFileSync(target(fixture, CLI_KEY));
    const rLf = runCli(cwd, fixture, ["--check"]);
    assertSpawnClean(rLf, "entry-3 LF");
    assert.equal(rLf.status, 0, `LF 副本 --check 应 exit 0；stderr: ${rLf.stderr}`);
    assert.match(rLf.stdout, /mcp-tools\.md is up to date/, "mcp-tools.md 应报 up to date");
    assert.match(rLf.stdout, /cli\.md is up to date/, "cli.md 应报 up to date");
    assert.deepEqual(readFileSync(target(fixture, MCP_KEY)), beforeLfMcp, "LF mcp-tools.md 原始字节不变");
    assert.deepEqual(readFileSync(target(fixture, CLI_KEY)), beforeLfCli, "LF cli.md 原始字节不变");

    // CRLF 副本（换行归一化后等价；不得被改写回 LF）。
    writeFileSync(target(fixture, MCP_KEY), expected[MCP_KEY].replace(/\n/g, "\r\n"), "utf8");
    writeFileSync(target(fixture, CLI_KEY), expected[CLI_KEY].replace(/\n/g, "\r\n"), "utf8");
    const beforeCrlfMcp = readFileSync(target(fixture, MCP_KEY));
    const beforeCrlfCli = readFileSync(target(fixture, CLI_KEY));
    const rCrlf = runCli(cwd, fixture, ["--check"]);
    assertSpawnClean(rCrlf, "entry-3 CRLF");
    assert.equal(rCrlf.status, 0, `CRLF 副本 --check 应 exit 0（归一化相同）；stderr: ${rCrlf.stderr}`);
    assert.deepEqual(readFileSync(target(fixture, MCP_KEY)), beforeCrlfMcp, "CRLF mcp-tools.md 不被改写为 LF");
    assert.deepEqual(readFileSync(target(fixture, CLI_KEY)), beforeCrlfCli, "CRLF cli.md 不被改写为 LF");
  } finally {
    rmrfRetry(home);
  }
});

// ===== 场景 4：--check 过期 / 垃圾 / 缺失 → 非零退出；不修复、不创建 =====
test("entry-4: --check 过期/垃圾/缺失 → 非零退出；不修复、不创建", async () => {
  const { home, fixture, cwd } = setup();
  try {
    const lib = await importFixtureLib(fixture);
    const expected = await lib.generate();
    const mcp = target(fixture, MCP_KEY);
    const cli = target(fixture, CLI_KEY);

    // 过期：渲染结果的一处 annotation hint 被漂移，形状合法但内容过期。
    assert.ok(expected[MCP_KEY].includes("readOnlyHint=true"), "夹具自检：渲染结果应含 readOnlyHint=true");
    const drifted = expected[MCP_KEY].replace("readOnlyHint=true", "readOnlyHint=drifted");
    assert.notEqual(drifted, expected[MCP_KEY], "夹具自检：漂移副本必须真的不同");
    writeFileSync(mcp, drifted, "utf8");
    writeFileSync(cli, expected[CLI_KEY], "utf8");
    const rStale = runCli(cwd, fixture, ["--check"]);
    assertSpawnClean(rStale, "entry-4 stale");
    assert.equal(rStale.status, 1, `过期应 exit 1；stdout: ${rStale.stdout}`);
    assert.match(rStale.stderr, /mcp-tools\.md is stale/, "过期分支 stderr 应指明 mcp-tools.md stale");
    assert.equal(readFileSync(mcp, "utf8"), drifted, "--check 不得修复过期文件");
    assert.equal(readFileSync(cli, "utf8"), expected[CLI_KEY], "未过期的 cli.md 不得被动");

    // 垃圾内容。
    writeFileSync(cli, "garbage, not markdown at all\n", "utf8");
    const rGarbage = runCli(cwd, fixture, ["--check"]);
    assertSpawnClean(rGarbage, "entry-4 garbage");
    assert.equal(rGarbage.status, 1, `垃圾内容应 exit 1；stdout: ${rGarbage.stdout}`);
    assert.equal(readFileSync(cli, "utf8"), "garbage, not markdown at all\n", "垃圾内容保持原样");

    // 缺失之一（cli.md 删掉）：exit 1、不创建、在场那份不动。
    rmSync(cli, { force: true });
    const rMissingOne = runCli(cwd, fixture, ["--check"]);
    assertSpawnClean(rMissingOne, "entry-4 missing one");
    assert.equal(rMissingOne.status, 1, `单份缺失应 exit 1；stdout: ${rMissingOne.stdout}`);
    assert.match(rMissingOne.stderr, /cli\.md does not exist/, "缺失分支 stderr 应指明 cli.md does not exist");
    assert.ok(!existsSync(cli), "--check 不得创建缺失文件");
    assert.equal(readFileSync(mcp, "utf8"), drifted, "在场的 mcp-tools.md 原始字节不动");

    // 全缺失（docs/ 整体删掉）：两份都报缺失、exit 1、目录不被创建。
    rmSync(join(fixture, "docs"), { recursive: true, force: true });
    const rMissingAll = runCli(cwd, fixture, ["--check"]);
    assertSpawnClean(rMissingAll, "entry-4 missing all");
    assert.equal(rMissingAll.status, 1, `全缺失应 exit 1；stdout: ${rMissingAll.stdout}`);
    assert.match(rMissingAll.stderr, /mcp-tools\.md does not exist/, "全缺失也应报 mcp-tools.md does not exist");
    assert.match(rMissingAll.stderr, /cli\.md does not exist/, "全缺失也应报 cli.md does not exist");
    assert.ok(!existsSync(join(fixture, "docs", "surface")), "--check 不得创建目录");
  } finally {
    rmrfRetry(home);
  }
});

// ===== 场景 5：派生失败（夹具 src/mcp/server.js 缺失）→ 非零退出，旧文件原样 =====
test("entry-5: 派生失败（动态 import 目标缺失）→ 非零退出，旧文件逐字节原样", () => {
  const { home, fixture, cwd } = setup();
  try {
    // 注入坏夹具：删掉 generate() 的动态 import 目标（静态 import 的 cliHelp.js
    // 仍在 ⇒ 库与 CLI 照常加载，隔离「派生失败」而不是「模块加载失败」）。
    rmSync(join(fixture, "src", "mcp", "server.js"), { force: true });

    writeFileSync(target(fixture, MCP_KEY), "OLD MCP — MUST SURVIVE\n", "utf8");
    writeFileSync(target(fixture, CLI_KEY), "OLD CLI — MUST SURVIVE\n", "utf8");
    const beforeMcp = readFileSync(target(fixture, MCP_KEY));
    const beforeCli = readFileSync(target(fixture, CLI_KEY));

    const rGen = runCli(cwd, fixture, []);
    assertSpawnClean(rGen, "entry-5 generate");
    assert.notEqual(rGen.status, 0, "派生失败必须非零退出");
    assert.ok(!rGen.stdout.includes("wrote"), "派生失败不得输出成功声明");
    assert.ok(rGen.stderr.length > 0, "失败原因应落在 stderr");
    assert.deepEqual(readFileSync(target(fixture, MCP_KEY)), beforeMcp, "生成失败：旧 mcp-tools.md 逐字节原样");
    assert.deepEqual(readFileSync(target(fixture, CLI_KEY)), beforeCli, "生成失败：旧 cli.md 逐字节原样");

    const rChk = runCli(cwd, fixture, ["--check"]);
    assertSpawnClean(rChk, "entry-5 check");
    assert.notEqual(rChk.status, 0, "派生失败下 --check 也必须非零退出");
    assert.ok(!rChk.stdout.includes("up to date"), "不得输出 up to date 成功声明");
    assert.deepEqual(readFileSync(target(fixture, MCP_KEY)), beforeMcp, "检查失败：旧 mcp-tools.md 仍逐字节原样");
    assert.deepEqual(readFileSync(target(fixture, CLI_KEY)), beforeCli, "检查失败：旧 cli.md 仍逐字节原样");
  } finally {
    rmrfRetry(home);
  }
});

// ===== 场景 6：写入失败（目标路径是目录）→ 非零退出，无成功声明 =====
test("entry-6: 写入失败（目标路径是目录）→ 非零退出，无成功声明", () => {
  const { home, fixture, cwd } = setup();
  try {
    // (a) 第一份（mcp-tools.md）的目标路径本身是目录：派生已成功，但零字节落盘。
    const mcp = target(fixture, MCP_KEY);
    rmSync(mcp, { force: true });
    mkdirSync(mcp);
    const rFirst = runCli(cwd, fixture, []);
    assertSpawnClean(rFirst, "entry-6 first target");
    assert.notEqual(rFirst.status, 0, "对目录路径写出必须非零退出");
    assert.ok(!rFirst.stdout.includes("wrote"), "首份写失败不得输出 wrote 成功声明");
    assert.ok(rFirst.stderr.length > 0, "失败原因应落在 stderr");
    assert.ok(statSync(mcp).isDirectory(), "目录保持目录（未被文件顶替）");
    assert.ok(!existsSync(target(fixture, CLI_KEY)), "首份即失败 ⇒ 第二份完全未写");

    // (b) 第二份（cli.md）的目标路径是目录：首份已成功更新（先派生后顺序写出
    // 的成文语义——两份内容都在任何字节落盘前完整派生），第二份失败非零退出。
    rmSync(mcp, { recursive: true, force: true });
    writeFileSync(mcp, "STALE MCP\n", "utf8");
    const cli = target(fixture, CLI_KEY);
    rmSync(cli, { force: true });
    mkdirSync(cli);
    const rSecond = runCli(cwd, fixture, []);
    assertSpawnClean(rSecond, "entry-6 second target");
    assert.notEqual(rSecond.status, 0, "第二份写失败必须非零退出");
    assert.match(rSecond.stdout, /wrote docs\/surface\/mcp-tools\.md/, "首份成功写出的声明应在（顺序写出语义）");
    assert.ok(!rSecond.stdout.includes("wrote docs/surface/cli.md"), "第二份不得有成功声明");
    assert.ok(statSync(cli).isDirectory(), "目录保持目录（未被文件顶替）");
    assert.notEqual(readFileSync(mcp, "utf8"), "STALE MCP\n", "首份已被更新（不是旧内容）");
  } finally {
    rmrfRetry(home);
  }
});

// ===== 场景 7：错误/重复/组合参数 → 非零退出，零副作用（含未派生证明） =====
test("entry-7: 未知/重复/组合参数 → 非零退出，不写入、不检查、不派生", async () => {
  const { home, fixture, cwd } = setup();
  try {
    const lib = await importFixtureLib(fixture);
    const expected = await lib.generate();
    const mcp = target(fixture, MCP_KEY);
    const cli = target(fixture, CLI_KEY);

    // 文件在位且正确：未知/重复/组合参数不得碰它，也不得执行检查。
    writeFileSync(mcp, expected[MCP_KEY], "utf8");
    writeFileSync(cli, expected[CLI_KEY], "utf8");
    const beforeMcp = readFileSync(mcp);
    const beforeCli = readFileSync(cli);
    for (const bad of [["--wat"], ["--check", "--check"], ["--check", "--wat"], ["--", "--check"]]) {
      const r = runCli(cwd, fixture, bad);
      assertSpawnClean(r, `entry-7 ${bad.join(" ")}`);
      assert.equal(r.status, 1, `${bad.join(" ")} 应 exit 1；stdout: ${r.stdout}`);
      assert.match(r.stderr, /unexpected arguments/, `${bad.join(" ")} stderr 应指明未知参数`);
      assert.ok(!r.stdout.includes("wrote"), `${bad.join(" ")} 不得有写出声明`);
      assert.ok(!r.stdout.includes("up to date"), `${bad.join(" ")} 不得有检查通过声明`);
    }
    assert.deepEqual(readFileSync(mcp), beforeMcp, "坏参数不得改写 mcp-tools.md");
    assert.deepEqual(readFileSync(cli), beforeCli, "坏参数不得改写 cli.md");

    // 文件缺失：坏参数也不得创建。
    rmSync(mcp, { force: true });
    rmSync(cli, { force: true });
    const rWat2 = runCli(cwd, fixture, ["--wat"]);
    assertSpawnClean(rWat2, "entry-7 --wat missing");
    assert.equal(rWat2.status, 1, "未知参数（目标缺失时）仍应 exit 1");
    assert.ok(!existsSync(mcp) && !existsSync(cli), "坏参数不得创建目标文件");

    // 未派生证明：把 generate() 的动态 import 目标删掉后跑 --wat —— 若派生被执行
    // 会以模块缺失错误崩溃；必须仍是干净的「unexpected arguments」用法错误。
    rmSync(join(fixture, "src", "mcp", "server.js"), { force: true });
    const rNoGen = runCli(cwd, fixture, ["--wat"]);
    assertSpawnClean(rNoGen, "entry-7 no-generate proof");
    assert.equal(rNoGen.status, 1, "坏参数分支必须先于派生退出");
    assert.match(rNoGen.stderr, /unexpected arguments/, "必须是用法错误，不是派生失败");
    assert.ok(!rNoGen.stderr.includes("Cannot find"), "不得出现模块解析错误（证明 generate 未被调用）");
  } finally {
    rmrfRetry(home);
  }
});

// ===== 场景 8：纯库零动作（import / 直接运行 / -e 伪装 argv）+ 导出面 =====
test("entry-8: import 库 / 直接运行库 / -e 导入且 argv 伪装 → 无生成、无检查、无退出动作", async () => {
  const { home, fixture, cwd } = setup();
  try {
    const libPath = join(fixture, "scripts", "gen-surface.mjs");
    const libUrl = JSON.stringify(pathToFileURL(libPath).href);
    const mcp = target(fixture, MCP_KEY);
    const cli = target(fixture, CLI_KEY);

    // (a) 普通 import：无输出、exit 0、不生成。
    const rPlain = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `await import(${libUrl})`],
      { cwd, ...SPAWN_OPTS },
    );
    assertSpawnClean(rPlain, "entry-8 plain import");
    assert.equal(rPlain.status, 0, `普通 import 应自然退出 0；stderr: ${rPlain.stderr}`);
    assert.equal(rPlain.stdout, "", "普通 import 不得有任何 stdout 输出");
    assert.equal(rPlain.stderr, "", "普通 import 不得有任何 stderr 输出");
    assert.ok(!existsSync(mcp) && !existsSync(cli), "普通 import 不得生成目标文件");

    // (b) 直接运行纯库本体（旧入口形状，含无参）：入口判定已删除 ⇒ 必须零动作。
    //     这是 fail-open 退场的直接回归钉（旧 `if (import.meta.main)` 会写出两份）。
    const rDirect = spawnSync(process.execPath, [libPath], { cwd, ...SPAWN_OPTS });
    assertSpawnClean(rDirect, "entry-8 direct run");
    assert.equal(rDirect.status, 0, `直接运行纯库应 exit 0；stderr: ${rDirect.stderr}`);
    assert.equal(rDirect.stdout, "", "直接运行纯库不得有任何 stdout 输出");
    assert.equal(rDirect.stderr, "", "直接运行纯库不得有任何 stderr 输出");
    assert.ok(!existsSync(mcp) && !existsSync(cli), "直接运行纯库不得生成目标文件");

    // (c) -e 导入 + argv 伪装成库路径 + --check（最强伪装形态：argv[1] 就是库自身
    //     真实路径）。目标缺失：若 --check 被执行会 exit 1——必须仍是 0 且零输出。
    const rDisguised = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `await import(${libUrl})`, libPath, "--check"],
      { cwd, ...SPAWN_OPTS },
    );
    assertSpawnClean(rDisguised, "entry-8 disguised import");
    assert.equal(rDisguised.status, 0, `伪装 argv 的 import 应 exit 0（不得执行 --check）；stderr: ${rDisguised.stderr}`);
    assert.equal(rDisguised.stdout, "", "伪装 argv 的 import 不得有任何 stdout 输出");
    assert.equal(rDisguised.stderr, "", "伪装 argv 的 import 不得有任何 stderr 输出");
    assert.ok(!existsSync(mcp) && !existsSync(cli), "伪装 argv 的 import 不得生成目标文件");

    // (d) 同上伪装，但磁盘放着过期文件：若 --check 被执行会 exit 1 且报 stale——
    //     必须零输出 exit 0，且过期字节原样（不是检查后不修复，是根本没检查）。
    writeFileSync(mcp, "STALE — MUST SURVIVE IMPORT\n", "utf8");
    const before = readFileSync(mcp);
    const rDisguised2 = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `await import(${libUrl})`, libPath, "--check"],
      { cwd, ...SPAWN_OPTS },
    );
    assertSpawnClean(rDisguised2, "entry-8 disguised import with stale file");
    assert.equal(rDisguised2.status, 0, "过期文件在场时伪装 import 仍应 exit 0（--check 未被执行）");
    assert.equal(rDisguised2.stdout, "");
    assert.equal(rDisguised2.stderr, "");
    assert.deepEqual(readFileSync(mcp), before, "过期文件必须逐字节原样");

    // (e) 纯库导出面：恰好 generate 与 render；render 是纯同步渲染（不建 server、
    //     不触网络、不写盘）——最小 tools 输入冒烟 + 与 generate() 的 cli.md 一致。
    const lib = await importFixtureLib(fixture);
    assert.deepEqual(
      Object.keys(lib).sort(),
      ["generate", "render"],
      "纯库只导出 generate 与 render",
    );
    const smokeTool = {
      name: "smoke_tool",
      description: "d",
      annotations: {},
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object", properties: {} },
    };
    const rendered = lib.render([smokeTool]);
    assert.equal(typeof rendered[MCP_KEY], "string", "render 应产出 mcp-tools.md 文本");
    assert.equal(typeof rendered[CLI_KEY], "string", "render 应产出 cli.md 文本");
    assert.ok(rendered[MCP_KEY].includes("## smoke_tool"), "render 应含传入工具的节");
    const full = await lib.generate();
    assert.equal(rendered[CLI_KEY], full[CLI_KEY], "render 与 generate 的 cli.md 一致（同一 SSOT）");
  } finally {
    rmrfRetry(home);
  }
});

// ===== 场景 9：package script 接线钉（薄 CLI + Node22 shim 前缀）=====
test("entry-9: package.json gen:surface 调薄 CLI（保留 wao-node v22 shim 前缀）", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  assert.equal(
    pkg.scripts?.["gen:surface"],
    "node scripts/wao-node.cjs scripts/gen-surface-cli.mjs",
    "gen:surface 必须经 wao-node shim 调薄 CLI（指回纯库会让 npm run gen:surface 静默零动作）",
  );
});
