// test/process/genCertificationEntry.test.js
//
// gen-certification「纯库 + 薄入口」拆分的入口回归（2026-09-22 收束包）。
// process 组：真实子进程（spawnSync node），temp 夹具在 os.tmpdir() 下。
//
// 被钉合同：
//   - scripts/gen-certification.mjs 是纯库：只导出 renderCertification()，导入
//     零副作用、零入口探测（无 import.meta.main / argv 比对 / realpath-ino 判定 /
//     process.exit）。旧实现的 F1（import.meta.main 在 Node < 22.18 为 undefined ⇒
//     fail-open 静默跳过）与 N1/N2（argv 判定误杀/漏杀）由此整块退场。
//   - scripts/gen-certification-cli.mjs 是唯一薄入口：无参＝写出；恰好 --check ＝
//     只读比对（CRLF/LF 归一化相同）；其他任何参数＝非零退出且不写不查。
//
// 夹具纪律：在 os.tmpdir() 下建保留相对目录结构的副本（cpSync 整个 src/、两个
// scripts/gen-certification*.mjs、建 docs/surface/），另放最小 package.json
// （type:module）使子进程的模块解析与真仓一致（否则 src/*.js 触发
// MODULE_TYPELESS_PACKAGE_JSON 重解析告警污染 stderr）。CLI 的 REPO_ROOT 从
// import.meta.url 派生 ⇒ spawn 的 cwd 用无关目录（不靠 cwd 找仓）。
// 断言不只看退出码：逐场景检查真实文件字节与目录副作用。清理复用 _rmrfHelper.mjs。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { rmrfRetry } from "../_rmrfHelper.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const CERT_REL = join("docs", "surface", "certification.md");
const SPAWN_OPTS = { encoding: "utf8", timeout: 120_000, windowsHide: true };

/** 建 tmp 夹具：src/ + 两个 gen-certification 脚本 + docs/surface/ + 最小 package.json。 */
function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), "wao-cert-entry-"));
  cpSync(join(REPO_ROOT, "src"), join(root, "src"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  cpSync(
    join(REPO_ROOT, "scripts", "gen-certification.mjs"),
    join(root, "scripts", "gen-certification.mjs"),
  );
  cpSync(
    join(REPO_ROOT, "scripts", "gen-certification-cli.mjs"),
    join(root, "scripts", "gen-certification-cli.mjs"),
  );
  mkdirSync(join(root, "docs", "surface"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"type":"module","private":true}\n', "utf8");
  return root;
}

/** 无关 cwd：独立 tmp 目录，既不是夹具、也不是仓，也不是夹具的业务祖先。 */
function buildUnrelatedCwd() {
  return mkdtempSync(join(tmpdir(), "wao-cert-unrelated-"));
}

/** 真实 spawn 薄入口（canonical 套件下 process.execPath 即 v22 node）。 */
function runCli(cwd, fixtureRoot, args) {
  return spawnSync(
    process.execPath,
    [join(fixtureRoot, "scripts", "gen-certification-cli.mjs"), ...args],
    { cwd, ...SPAWN_OPTS },
  );
}

/** spawn 基线：无 error、无 signal（status 由各场景自己比较）。 */
function assertSpawnClean(r, label) {
  assert.ok(!r.error, `${label}: spawn error = ${r.error}`);
  assert.equal(r.signal, null, `${label}: signal 应为 null`);
}

/** import 夹具纯库拿真实渲染结果（夹具 src 是真仓副本，渲染逐字节相同）。 */
async function importFixtureRenderer(fixtureRoot) {
  const mod = await import(
    pathToFileURL(join(fixtureRoot, "scripts", "gen-certification.mjs")).href
  );
  return mod.renderCertification;
}

// ===== 场景 1：目标缺失 + 无参生成 → 创建正确文件，内容 == 真实渲染结果 =====
test("entry-1: 目标缺失 + 无参 → 递归建目录并写出，内容逐字等于 renderCertification()", async () => {
  const fixture = buildFixture();
  const cwd = buildUnrelatedCwd();
  try {
    rmSync(join(fixture, "docs"), { recursive: true, force: true }); // 连 docs/ 一起删，证明 mkdir -p
    const renderCertification = await importFixtureRenderer(fixture);
    const r = runCli(cwd, fixture, []);
    assertSpawnClean(r, "entry-1");
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const target = join(fixture, CERT_REL);
    assert.ok(existsSync(target), "目标文件应被创建");
    assert.equal(readFileSync(target, "utf8"), renderCertification(), "内容必须逐字等于真实渲染结果");
    assert.match(r.stdout, /wrote docs\/surface\/certification\.md/, "stdout 应声明写出");
    assert.match(
      r.stdout,
      new RegExp(`\(${Buffer.byteLength(renderCertification(), "utf8")} bytes\)`),
      "stdout 字节数应与实际一致",
    );
  } finally {
    rmrfRetry(fixture);
    rmrfRetry(cwd);
  }
});

// ===== 场景 2：目标过期 + 无参生成 → 更新正确；再次执行内容不变（幂等） =====
test("entry-2: 目标过期 + 无参 → 更新为渲染结果；再跑一次字节不变（幂等）", async () => {
  const fixture = buildFixture();
  const cwd = buildUnrelatedCwd();
  try {
    const target = join(fixture, CERT_REL);
    writeFileSync(target, "STALE CONTENT\n", "utf8");
    const renderCertification = await importFixtureRenderer(fixture);
    const r1 = runCli(cwd, fixture, []);
    assertSpawnClean(r1, "entry-2 first");
    assert.equal(r1.status, 0, `stderr: ${r1.stderr}`);
    assert.equal(readFileSync(target, "utf8"), renderCertification(), "过期文件应被更新为渲染结果");
    const before = readFileSync(target);
    const r2 = runCli(cwd, fixture, []);
    assertSpawnClean(r2, "entry-2 second");
    assert.equal(r2.status, 0, `stderr: ${r2.stderr}`);
    assert.deepEqual(readFileSync(target), before, "幂等：再次生成后原始字节必须不变");
  } finally {
    rmrfRetry(fixture);
    rmrfRetry(cwd);
  }
});

// ===== 场景 3：--check 正常 / CRLF → exit 0，文件原始字节不变 =====
test("entry-3: --check 对 LF 与 CRLF 磁盘副本均 exit 0，且原始字节不动", async () => {
  const fixture = buildFixture();
  const cwd = buildUnrelatedCwd();
  try {
    const target = join(fixture, CERT_REL);
    const renderCertification = await importFixtureRenderer(fixture);
    const rendered = renderCertification();

    writeFileSync(target, rendered, "utf8"); // LF 副本
    const beforeLf = readFileSync(target);
    const rLf = runCli(cwd, fixture, ["--check"]);
    assertSpawnClean(rLf, "entry-3 LF");
    assert.equal(rLf.status, 0, `LF 副本 --check 应 exit 0；stderr: ${rLf.stderr}`);
    assert.deepEqual(readFileSync(target), beforeLf, "LF 原始字节不变");

    const crlf = rendered.replace(/\n/g, "\r\n");
    writeFileSync(target, crlf, "utf8"); // CRLF 副本（换行归一化后等价）
    const beforeCrlf = readFileSync(target);
    const rCrlf = runCli(cwd, fixture, ["--check"]);
    assertSpawnClean(rCrlf, "entry-3 CRLF");
    assert.equal(rCrlf.status, 0, `CRLF 副本 --check 应 exit 0（归一化相同）；stderr: ${rCrlf.stderr}`);
    assert.match(rCrlf.stdout, /is up to date/, "成功分支 stdout 应报 up to date");
    assert.deepEqual(readFileSync(target), beforeCrlf, "CRLF 原始字节不被改写为 LF");
  } finally {
    rmrfRetry(fixture);
    rmrfRetry(cwd);
  }
});

// ===== 场景 4：--check 过期 / 缺失 / 垃圾内容 → 非零退出，不修复、不创建 =====
test("entry-4: --check 过期/缺失/垃圾 → 非零退出；不修复、不创建", async () => {
  const fixture = buildFixture();
  const cwd = buildUnrelatedCwd();
  try {
    const target = join(fixture, CERT_REL);
    const renderCertification = await importFixtureRenderer(fixture);
    const rendered = renderCertification();

    // 过期：渲染结果的一个表格格被漂移（✅→❌），形状合法但内容过期。
    const drifted = rendered.replace("✅", "❌");
    assert.notEqual(drifted, rendered, "夹具自检：漂移副本必须真的不同");
    writeFileSync(target, drifted, "utf8");
    const rStale = runCli(cwd, fixture, ["--check"]);
    assertSpawnClean(rStale, "entry-4 stale");
    assert.equal(rStale.status, 1, `过期应 exit 1；stdout: ${rStale.stdout}`);
    assert.match(rStale.stderr, /is stale/, "过期分支 stderr 应指明 stale");
    assert.equal(readFileSync(target, "utf8"), drifted, "--check 不得修复过期文件");

    // 垃圾内容。
    writeFileSync(target, "garbage, not markdown at all\n", "utf8");
    const rGarbage = runCli(cwd, fixture, ["--check"]);
    assertSpawnClean(rGarbage, "entry-4 garbage");
    assert.equal(rGarbage.status, 1, `垃圾内容应 exit 1；stdout: ${rGarbage.stdout}`);
    assert.equal(readFileSync(target, "utf8"), "garbage, not markdown at all\n", "垃圾内容保持原样");

    // 缺失。
    rmSync(target, { force: true });
    const rMissing = runCli(cwd, fixture, ["--check"]);
    assertSpawnClean(rMissing, "entry-4 missing");
    assert.equal(rMissing.status, 1, `缺失应 exit 1；stdout: ${rMissing.stdout}`);
    assert.match(rMissing.stderr, /does not exist/, "缺失分支 stderr 应指明 does not exist");
    assert.ok(!existsSync(target), "--check 不得创建文件");
  } finally {
    rmrfRetry(fixture);
    rmrfRetry(cwd);
  }
});

// ===== 场景 5：渲染失败（注入坏夹具）→ 非零退出，旧文件保持原样 =====
test("entry-5: 渲染失败（kimiCode KIMI_K3_MODEL_ID 源常量被改名）→ 非零退出，旧文件原样", () => {
  const fixture = buildFixture();
  const cwd = buildUnrelatedCwd();
  try {
    // 注入坏夹具：源常量标识符整体改名（模块仍可解析加载——隔离渲染失败，
    // 不是模块加载失败），extractKimiK3ModelId 的正则锚点即失配抛错。
    const kimi = join(fixture, "src", "backends", "kimiCode.js");
    const src = readFileSync(kimi, "utf8");
    assert.match(src, /const KIMI_K3_MODEL_ID = "/, "夹具自检：kimiCode.js 应含源常量");
    writeFileSync(kimi, src.replaceAll("KIMI_K3_MODEL_ID", "KIMI_K3_MODEL_ID_BROKEN"), "utf8");

    const target = join(fixture, CERT_REL);
    writeFileSync(target, "OLD CONTENT — MUST SURVIVE\n", "utf8");
    const before = readFileSync(target);

    const rGen = runCli(cwd, fixture, []);
    assertSpawnClean(rGen, "entry-5 generate");
    assert.notEqual(rGen.status, 0, "渲染失败必须非零退出");
    assert.ok(!rGen.stdout.includes("wrote"), "渲染失败不得输出成功声明");
    assert.deepEqual(readFileSync(target), before, "生成失败：旧文件必须逐字节原样");

    const rChk = runCli(cwd, fixture, ["--check"]);
    assertSpawnClean(rChk, "entry-5 check");
    assert.notEqual(rChk.status, 0, "渲染失败下 --check 也必须非零退出");
    assert.ok(!rChk.stdout.includes("up to date"), "不得输出 up to date 成功声明");
    assert.deepEqual(readFileSync(target), before, "检查失败：旧文件仍逐字节原样");
  } finally {
    rmrfRetry(fixture);
    rmrfRetry(cwd);
  }
});

// ===== 场景 6：写入失败（目标路径是目录）→ 非零退出，不输出成功声明 =====
test("entry-6: 写入失败（docs/surface/certification.md 是目录）→ 非零退出，无成功声明", () => {
  const fixture = buildFixture();
  const cwd = buildUnrelatedCwd();
  try {
    const target = join(fixture, CERT_REL);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target); // 目标路径本身是个目录
    const r = runCli(cwd, fixture, []);
    assertSpawnClean(r, "entry-6");
    assert.notEqual(r.status, 0, "对目录路径写出必须非零退出");
    assert.ok(!r.stdout.includes("wrote"), "写入失败不得输出 wrote 成功声明");
    assert.ok(r.stderr.length > 0, "失败原因应落在 stderr");
    assert.ok(statSync(target).isDirectory(), "目录保持目录（未被文件顶替）");
  } finally {
    rmrfRetry(fixture);
    rmrfRetry(cwd);
  }
});

// ===== 场景 7：未知参数（--wat）→ 非零退出，无写入 =====
test("entry-7: 未知参数 → 非零退出，不写入、不检查", async () => {
  const fixture = buildFixture();
  const cwd = buildUnrelatedCwd();
  try {
    const renderCertification = await importFixtureRenderer(fixture);
    const target = join(fixture, CERT_REL);

    // 文件在位且正确：--wat 不得碰它。
    writeFileSync(target, renderCertification(), "utf8");
    const before = readFileSync(target);
    const rWat = runCli(cwd, fixture, ["--wat"]);
    assertSpawnClean(rWat, "entry-7 --wat");
    assert.equal(rWat.status, 1, `未知参数应 exit 1；stdout: ${rWat.stdout}`);
    assert.match(rWat.stderr, /unexpected arguments/, "stderr 应指明未知参数");
    assert.deepEqual(readFileSync(target), before, "--wat 不得改写已存在的目标");

    // 文件缺失：--wat 也不得创建。
    rmSync(target, { force: true });
    const rWat2 = runCli(cwd, fixture, ["--wat"]);
    assertSpawnClean(rWat2, "entry-7 --wat missing");
    assert.equal(rWat2.status, 1, "未知参数（目标缺失时）仍应 exit 1");
    assert.ok(!existsSync(target), "--wat 不得创建目标文件");

    // 两个参数（--check --wat）：不是恰好 --check，必须走未知参数分支——
    // 用过期文件证明 --check 没有被执行（未被检查放行，也未被修复）。
    const drifted = renderCertification().replace("✅", "❌");
    writeFileSync(target, drifted, "utf8");
    const rTwo = runCli(cwd, fixture, ["--check", "--wat"]);
    assertSpawnClean(rTwo, "entry-7 --check --wat");
    assert.equal(rTwo.status, 1, "多参数（含 --check）应 exit 1 而不是执行检查");
    assert.equal(readFileSync(target, "utf8"), drifted, "该组合不得修复/改写文件");
  } finally {
    rmrfRetry(fixture);
    rmrfRetry(cwd);
  }
});

// ===== 场景 8：import 纯库 / -e 导入库且 argv 伪装成本文件路径 → 零动作 =====
test("entry-8: import 库 / -e 导入库且 argv 伪装成本文件路径 → 无生成、无检查、无退出动作", () => {
  const fixture = buildFixture();
  const cwd = buildUnrelatedCwd();
  try {
    const lib = join(fixture, "scripts", "gen-certification.mjs");
    const libUrl = JSON.stringify(pathToFileURL(lib).href);
    const target = join(fixture, CERT_REL);

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
    assert.ok(!existsSync(target), "普通 import 不得生成目标文件");

    // (b) -e 导入 + argv 伪装成本文件路径 + --check（旧 N1/N2/-e 反例的最强形态：
    // argv[1] 就是库自身真实路径——旧 ino/dev 文件身份判定会命中入口并执行 --check）。
    // 目标缺失：若 --check 被执行会 exit 1——必须仍是 0 且零输出。
    const rDisguised = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `await import(${libUrl})`, lib, "--check"],
      { cwd, ...SPAWN_OPTS },
    );
    assertSpawnClean(rDisguised, "entry-8 disguised import");
    assert.equal(
      rDisguised.status, 0,
      `伪装 argv 的 import 应 exit 0（不得执行 --check）；stderr: ${rDisguised.stderr}`,
    );
    assert.equal(rDisguised.stdout, "", "伪装 argv 的 import 不得有任何 stdout 输出");
    assert.equal(rDisguised.stderr, "", "伪装 argv 的 import 不得有任何 stderr 输出");
    assert.ok(!existsSync(target), "伪装 argv 的 import 不得生成目标文件");

    // (c) 同上伪装，但磁盘放着过期文件：若 --check 被执行会 exit 1 且打 stale——
    // 必须零输出 exit 0，且过期字节原样（不是检查后不修复，是根本没检查）。
    writeFileSync(target, "STALE — MUST SURVIVE IMPORT\n", "utf8");
    const before = readFileSync(target);
    const rDisguised2 = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `await import(${libUrl})`, lib, "--check"],
      { cwd, ...SPAWN_OPTS },
    );
    assertSpawnClean(rDisguised2, "entry-8 disguised import with stale file");
    assert.equal(
      rDisguised2.status, 0,
      "过期文件在场时伪装 import 仍应 exit 0（--check 未被执行）",
    );
    assert.equal(rDisguised2.stdout, "");
    assert.equal(rDisguised2.stderr, "");
    assert.deepEqual(readFileSync(target), before, "过期文件必须逐字节原样");
  } finally {
    rmrfRetry(fixture);
    rmrfRetry(cwd);
  }
});
