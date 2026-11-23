// test/process/harnessInventory.test.js
//
// harness-inventory 盘点命令回归（2026-11-23 第 138 批）。探针、npm 查询、更新器
// 日志读取全部走注入缝——本文件不调真实网络、不 spawn 真实 binary；真实接线由
// runtimeIdentity.test.js（注入 spawnFn）、kimiWebIdentityProbe.test.js 与模板
// 试跑覆盖。CLI 接线断言仿 runtimeIdentityCli.test.js（进程内注入 stdout/stderr）。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { readRegistry } from "../../src/registry.js";
import {
  parseArgs,
  extractVersion,
  compareParsedVersions,
  classifyConclusion,
  selectDistTags,
  parseUpdaterLine,
  selectUpdaterConclusion,
  dedupeTargets,
  crossChannelVerdict,
  npmDistTags,
  collectRows,
  renderText,
  renderJson,
  main,
} from "../../scripts/reliability/harness-inventory.mjs";

// ---- parseArgs ----

test("parseArgs: 缺省读 live 注册表 config/agents.json（用法里写明读取面）、format 缺省 text", () => {
  assert.deepEqual(parseArgs([]), { registry: "config/agents.json", format: "text" });
  assert.deepEqual(parseArgs(["--registry", "x.json", "--format", "json"]),
    { registry: "x.json", format: "json" });
});

test("parseArgs: help 优先、裸 flag 缺值抛错、未知 flag 抛错、非法 format 抛错（不静默降级）", () => {
  assert.equal(parseArgs(["--help"]).help, true);
  assert.throws(() => parseArgs(["--registry"]), /--registry requires a value/);
  assert.throws(() => parseArgs(["--nope"]), /unknown flag: --nope/);
  assert.throws(() => parseArgs(["--format", "yaml"]), /--format must be text or json/);
});

// ---- 版本解析与三档结论 ----

test("extractVersion: 从探针输出行取首个版本 token；四段 exe 版本与 rc 预发布都能解析", () => {
  assert.deepEqual(extractVersion("2.1.330 (Claude Code)"), { core: [2, 1, 330], pre: null });
  assert.deepEqual(extractVersion("codex-cli 0.171.0"), { core: [0, 171, 0], pre: null });
  assert.deepEqual(extractVersion("0.2.2-rc.5"), { core: [0, 2, 2], pre: ["rc", "5"] });
  assert.deepEqual(extractVersion("4.0.0.0"), { core: [4, 0, 0, 0], pre: null });
  assert.equal(extractVersion("no version here"), null);
  assert.equal(extractVersion(null), null);
});

test("compareParsedVersions: 前三段核心（缺段补 0）+ 预发布序；exe 四段式与三段式按前三段对照", () => {
  assert.equal(compareParsedVersions(extractVersion("4.0.0.10870"), extractVersion("4.0.0")), 0,
    "四段 exe 对三段更新器：第四段起的差异不进结论（runbook 在册口径）");
  assert.equal(compareParsedVersions(extractVersion("4.0.1.10870"), extractVersion("4.0.0")), 1, "前三段不同必须可辨");
  assert.equal(compareParsedVersions(extractVersion("2.7.2"), extractVersion("2.7.2")), 0);
  assert.equal(compareParsedVersions(extractVersion("2.1.329"), extractVersion("2.1.330")), -1);
  assert.equal(compareParsedVersions(extractVersion("0.2.2-rc.5"), extractVersion("0.2.2-rc.6")), -1);
  assert.equal(compareParsedVersions(extractVersion("0.2.2-rc.5"), extractVersion("0.2.2")), -1);
  assert.equal(compareParsedVersions(extractVersion("1.0.0-beta.2"), extractVersion("1.0.0-beta.10")), -1);
});

test("classifyConclusion: 相等→latest、不等→behind、任一侧不可解析→unknown（不可探不算零差异）", () => {
  assert.equal(classifyConclusion("2.7.2", "2.7.2"), "latest");
  assert.equal(classifyConclusion("2.7.1", "2.7.2"), "behind");
  assert.equal(classifyConclusion("0.2.2-rc.5", "0.2.2-rc.5"), "latest");
  assert.equal(classifyConclusion("4.0.0.10870", "4.0.0"), "latest", "四段产品版本对三段最新 → latest");
  assert.equal(classifyConclusion(null, "4.0.0"), "unknown");
  assert.equal(classifyConclusion("4.0.0", null), "unknown");
  assert.equal(classifyConclusion("不可解析", "4.0.0"), "unknown");
});

// ---- dist-tag 取值 ----

test("selectDistTags: 只取 latest；stable/next 与本地不同才附注；latest 本身是 rc 照实附注", () => {
  const r1 = selectDistTags({ latest: "2.7.2" }, "2.7.2");
  assert.equal(r1.latest, "2.7.2");
  assert.deepEqual(r1.notes, []);

  const r2 = selectDistTags({ latest: "3.0.0", stable: "2.7.2" }, "2.6.0");
  assert.equal(r2.latest, "3.0.0");
  assert.match(r2.notes.join(";"), /stable=2\.7\.2/);

  const r3 = selectDistTags({ latest: "3.0.0", next: "4.0.0-beta.1" }, "2.7.2");
  assert.match(r3.notes.join(";"), /next=4\.0\.0-beta\.1/);

  // 本地恰好等于 stable（latest 领先）：stable 与本地相同 → 不附注 stable
  const r4 = selectDistTags({ latest: "3.0.0", stable: "2.7.2" }, "2.7.2");
  assert.ok(!r4.notes.some((n) => n.includes("stable")), "与本地相同的 tag 不附注");

  // dsh 形状：latest 本身是 rc
  const r5 = selectDistTags({ latest: "0.2.2-rc.5" }, "0.2.2-rc.5");
  assert.match(r5.notes.join(";"), /预发布/);

  assert.deepEqual(selectDistTags({}, "2.7.2"), { latest: null, notes: ["dist-tags 无 latest tag"] });
});

test("selectDistTags: 声明 followTag 时只比该 tag（映射内锚取实际跟随的 tag；stable/next 不附注）", () => {
  const r = selectDistTags({ latest: "3.0.0", stable: "2.7.2", next: "4.0.0-beta.1" }, "2.6.0", { followTag: "latest" });
  assert.equal(r.latest, "3.0.0");
  assert.deepEqual(r.notes, [], "声明跟随关系后只比该 tag");
  const missing = selectDistTags({ latest: "3.0.0" }, "2.6.0", { followTag: "stable" });
  assert.equal(missing.latest, null);
  assert.match(missing.notes.join(";"), /无 stable tag/);
});

// ---- npm dist-tags 查询（fetch 注入；不经 npm 进程）----

test("npmDistTags: fetch 注入直击公共注册表 dist-tags 端点（包名 / 按 URL 编码）；非 2xx 与网络错误记原因", async () => {
  let seenUrl = null;
  const ok = await npmDistTags("@openai/codex", {
    fetchFn: async (url) => {
      seenUrl = url;
      return { ok: true, status: 200, json: async () => ({ latest: "0.171.0" }) };
    },
  });
  assert.deepEqual(ok, { tags: { latest: "0.171.0" }, reason: null });
  assert.equal(seenUrl, "https://registry.npmjs.org/-/package/@openai%2Fcodex/dist-tags");

  const http404 = await npmDistTags("@x/y", { fetchFn: async () => ({ ok: false, status: 404 }) });
  assert.equal(http404.tags, null);
  assert.match(http404.reason, /HTTP 404/);

  const offline = await npmDistTags("@x/y", { fetchFn: async () => { throw new Error("fetch timeout"); } });
  assert.equal(offline.tags, null);
  assert.match(offline.reason, /fetch timeout/);
});

// ---- 跨渠道判定（参照渠道映射内/外）----

test("crossChannelVerdict: 映射内（claude-code/kimi-web）可比已确认且只跟随声明的 tag；npm 渠道直接对照；映射外 conclusive:false", () => {
  const claude = crossChannelVerdict("claude-code");
  assert.equal(claude.conclusive, true);
  assert.equal(claude.followTag, "latest");
  assert.match(claude.note, /可比已确认/);
  assert.match(claude.note, /@anthropic-ai\/claude-code/);

  const kimi = crossChannelVerdict("kimi-web");
  assert.equal(kimi.conclusive, true);
  assert.match(kimi.note, /@moonshot-ai\/kimi-code/);

  const codex = crossChannelVerdict("codex");
  assert.equal(codex.conclusive, true, "npm 渠道本地安装与官方 latest 同渠道");
  assert.equal(codex.followTag, "latest");
  assert.equal(codex.note, null, "同渠道直接对照不需要跨渠道注记");

  const unknownForm = crossChannelVerdict("hypothetical-native");
  assert.equal(unknownForm.conclusive, false);
  assert.equal(unknownForm.followTag, null);
});

// ---- ZCode 更新器日志解析 ----

test("parseUpdaterLine: 两种结论行都识别（Found version / already up to date），非结论行返回 null", () => {
  const found = parseUpdaterLine("[2026-11-12 22:10:56.275] [info] [pid:45976] [main] Found version 3.18.2 (url: https://cdn-zcode.z.ai/x.exe)");
  assert.deepEqual({ kind: found.kind, version: found.version, timestamp: found.timestamp },
    { kind: "found", version: "3.18.2", timestamp: "2026-11-12 22:10:56" });

  const uptodate = parseUpdaterLine("[2026-11-23 07:03:05.151] [info] [pid:39624] [main] [auto-update] already up to date (local=4.0.0, remote=4.0.0)");
  assert.deepEqual({ kind: uptodate.kind, version: uptodate.version, timestamp: uptodate.timestamp, local: uptodate.local },
    { kind: "up_to_date", version: "4.0.0", timestamp: "2026-11-23 07:03:05", local: "4.0.0" });

  assert.equal(parseUpdaterLine("[2026-11-23 07:00:00.000] [info] [pid:1] [main] downloading update"), null);
  assert.equal(parseUpdaterLine(""), null);
  assert.equal(parseUpdaterLine(null), null);
});

test("selectUpdaterConclusion: 取最新一份日志的最后一条结论（最近一条结论，不是第一条）", () => {
  const newest = {
    name: "2026-11-23.log",
    content: [
      "[2026-11-23 06:00:00.000] [info] [pid:1] [main] Found version 4.1.0 (url: x)",
      "[2026-11-23 07:03:05.151] [info] [pid:1] [main] [auto-update] already up to date (local=4.0.0, remote=4.0.0)",
    ].join("\n"),
  };
  const r = selectUpdaterConclusion([newest, { name: "2026-11-22.log", content: "[2026-11-22 01:00:00.000] [info] [pid:1] [main] Found version 9.9.9 (url: x)" }]);
  assert.equal(r.version, "4.0.0", "同文件取最后一条");
  assert.equal(r.logFile, "2026-11-23.log");

  const r2 = selectUpdaterConclusion([
    { name: "2026-11-23.log", content: "nothing here" },
    { name: "2026-11-22.log", content: "[2026-11-22 01:00:00.000] [info] [pid:1] [main] Found version 4.1.0 (url: x)" },
  ]);
  assert.equal(r2.version, "4.1.0", "最新文件无结论时回看次新文件");
  assert.equal(selectUpdaterConclusion([{ name: "a.log", content: "" }]), null);
});

// ---- 目标去重（按解析后的实际目标；解析缝注入，不触真实 where.exe/binary）----

const passthroughResolution = async (config) => (config?.binary
  ? { binary: config.binary, args: Array.isArray(config?.prependArgs) ? config.prependArgs : [] }
  : null);
const identityResolve = (name) => name;

test("dedupeTargets: 按解析后的实际目标去重——同 backend 同目标只探一次并列出全部席位", async () => {
  const entries = [
    ["glm-pro", { backend: "zcode", binary: "C:/a/zcode.cjs" }],
    ["glm-flash", { backend: "zcode", binary: "C:/a/zcode.cjs" }],
    ["glm-alt", { backend: "zcode", binary: "C:/b/zcode.cjs" }],
    ["sol", { backend: "codex" }],
    ["astra", { backend: "codex" }],
    ["opus", { backend: "claude-code" }],
  ];
  const groups = await dedupeTargets(entries, { resolveInvocationFn: passthroughResolution, resolveBareFn: identityResolve });
  assert.deepEqual(groups.map((g) => [g.backend, g.seats]),
    [
      ["zcode", ["glm-pro", "glm-flash"]],
      ["zcode", ["glm-alt"]],
      ["codex", ["sol", "astra"]],
      ["claude-code", ["opus"]],
    ]);
  assert.equal(groups[0].anchor.id, "glm-pro", "组锚点=首个席位");
  assert.equal(groups[0].anchor.config.binary, "C:/a/zcode.cjs", "锚点携带配置供探针消费");
});

test("dedupeTargets: 裸名与绝对路径指向同一目标时合并为一行（证据单位是实际安装，不是配置写法）", async () => {
  const groups = await dedupeTargets(
    [["sol", { backend: "codex" }], ["sol2", { backend: "codex", binary: "C:/Tools/codex.cmd" }]],
    {
      resolveInvocationFn: passthroughResolution,
      resolveBareFn: (name) => (name === "codex" ? "C:/Tools/codex.cmd" : name),
    },
  );
  assert.equal(groups.length, 1, "裸名解析后的绝对路径与手写绝对路径落同一键");
  assert.deepEqual(groups[0].seats, ["sol", "sol2"]);
});

// ---- 盘点编排（全注入，零真实网络/binary）----

function fakeDeps({
  probeResults = {},
  distTags = {},
  updater = { conclusion: null, reason: "日志缺失" },
  productVersions = {},
} = {}) {
  return {
    probeFn: async ({ backendName, agent }) => probeResults[`${backendName}@${agent.binary ?? "default"}`]
      ?? { distribution: null, version: null, binaryPath: agent.binary ?? "default", fingerprint: "unverified-v1-x", verified: false, reason: "probe not staged" },
    npmViewFn: (pkg) => distTags[pkg] ?? { tags: null, reason: "npm not staged" },
    readUpdaterFn: () => updater,
    productVersionFn: (exePath) => productVersions[exePath] ?? { version: null, reason: "exe not staged" },
    hashFn: (p) => ({ hash: p ? "deadbeef1234" : null, reason: null }),
  };
}

test("collectRows: npm backend 按 latest 判三档；behind 行结论正确且 JSON 行形状齐备", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-hinv-"));
  try {
    const regPath = join(dir, "agents.json");
    writeFileSync(regPath, JSON.stringify({ agents: { sol: { backend: "codex" } } }));
    const rows = await collectRows({
      registryPath: regPath,
      readRegistryFn: readRegistry,
      ...fakeDeps({ distTags: { "@openai/codex": { tags: { latest: "0.171.0" } } }, probeResults: { "codex@default": { distribution: "codex", version: "0.170.0", binaryPath: "codex.exe", fingerprint: "v1-x", verified: true, reason: null } } }),
    });
    assert.equal(rows.length, 5, "1 行有席位（codex）+ 4 行无席位闭集成员（覆盖面不缩水）");
    const row = rows[0];
    assert.equal(row.backend, "codex");
    assert.equal(row.seats[0], "sol");
    assert.equal(row.localVersion, "0.170.0");
    assert.equal(row.latestVersion, "0.171.0");
    assert.equal(row.latestSource, "npm dist-tag latest (@openai/codex)");
    assert.equal(row.conclusion, "behind");
    assert.ok(Array.isArray(row.notes) && row.notes.some((n) => n.startsWith("席位: ")));
    assert.deepEqual(Object.keys(row).sort(),
      ["anchorAgentId", "backend", "conclusion", "latestSource", "latestVersion", "localVerified", "localVersion", "notes", "seats", "target"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectRows: zcode 本地版本列显示产品版本（四段式对三段式 latest）；bundle 自报只在备注出现一次", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-hinv-"));
  try {
    const regPath = join(dir, "agents.json");
    const bundle = "C:/ZCode/resources/glm/zcode.cjs";
    writeFileSync(regPath, JSON.stringify({ agents: { glm: { backend: "zcode", binary: bundle } } }));
    const rows = await collectRows({
      registryPath: regPath,
      readRegistryFn: readRegistry,
      ...fakeDeps({
        probeResults: { [`zcode@${bundle}`]: { distribution: "zcode", version: "0.18.0", binaryPath: "node", fingerprint: "v1-x", verified: true, reason: null } },
        updater: {
          conclusion: { kind: "up_to_date", version: "4.0.0", timestamp: "2026-11-23 07:03:05", local: "4.0.0", logFile: "2026-11-23.log" },
          reason: null,
        },
        // 主 exe 路径与生产同法派生（<bundle>/../../ZCode.exe），键与平台路径形状无关
        productVersions: { [resolve(dirname(bundle), "..", "..", "ZCode.exe")]: { version: "4.0.0.10870", reason: null } },
      }),
    });
    assert.equal(rows.length, 5, "1 行 zcode + 4 行无席位闭集成员");
    const row = rows[0];
    assert.equal(row.latestVersion, "4.0.0");
    assert.match(row.latestSource, /2026-11-23\.log @ 2026-11-23 07:03:05/);
    assert.equal(row.extras.productVersion, "4.0.0.10870");
    assert.equal(row.extras.bundleSha256, "deadbeef1234");
    assert.equal(row.localVersion, "4.0.0.10870", "本地版本列显示产品版本（对照锚）");
    assert.equal(row.conclusion, "latest", "四段式 exe 对三段式更新器按前三段判等");
    assert.equal(row.notes.filter((n) => n.includes("内部序列")).length, 1, "bundle 自报只在备注出现一次");
    assert.ok(!row.notes.some((n) => n.includes("不一致")), "前三段相等时不附不一致注记");
    assert.ok(!row.notes.some((n) => n.includes("本地对照取产品版本")), "旧重复句式已合并成一句");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectRows: zcode 前三段不同 → behind 且提示更新器自报与 exe 不一致；产品版本缺席时结论 unknown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-hinv-"));
  try {
    const regPath = join(dir, "agents.json");
    const bundle = "C:/ZCode/resources/glm/zcode.cjs";
    writeFileSync(regPath, JSON.stringify({ agents: { glm: { backend: "zcode", binary: bundle } } }));
    const exeKey = resolve(dirname(bundle), "..", "..", "ZCode.exe");
    const behindRows = await collectRows({
      registryPath: regPath,
      readRegistryFn: readRegistry,
      ...fakeDeps({
        probeResults: { [`zcode@${bundle}`]: { distribution: "zcode", version: "0.18.0", binaryPath: "node", fingerprint: "v1-x", verified: true, reason: null } },
        updater: { conclusion: { kind: "up_to_date", version: "4.0.0", timestamp: "2026-11-23 07:03:05", local: "4.0.0", logFile: "2026-11-23.log" }, reason: null },
        productVersions: { [exeKey]: { version: "4.0.1.10870", reason: null } },
      }),
    });
    const behind = behindRows[0];
    assert.equal(behind.conclusion, "behind", "前三段 4.0.1 对 4.0.0 → behind");
    assert.ok(behind.notes.some((n) => n.includes("不一致")), "前三段不同才提示更新器自报与 exe 不一致");

    const unknownRows = await collectRows({
      registryPath: regPath,
      readRegistryFn: readRegistry,
      ...fakeDeps({
        probeResults: { [`zcode@${bundle}`]: { distribution: "zcode", version: "0.18.0", binaryPath: "node", fingerprint: "v1-x", verified: true, reason: null } },
        updater: { conclusion: { kind: "up_to_date", version: "4.0.0", timestamp: "2026-11-23 07:03:05", local: "4.0.0", logFile: "2026-11-23.log" }, reason: null },
        productVersions: { [exeKey]: { version: null, reason: "VersionInfo 读取失败（exit=1）" } },
      }),
    });
    const unknown = unknownRows[0];
    assert.equal(unknown.localVersion, null, "产品版本缺席不拿 bundle 序列参比");
    assert.equal(unknown.conclusion, "unknown");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectRows: kimi-web 行附服务身份未确认注记；npm 查询失败是 unknown 不是失败；无席位闭集 backend 出 unknown 行", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-hinv-"));
  try {
    const regPath = join(dir, "agents.json");
    writeFileSync(regPath, JSON.stringify({ agents: { kimi: { backend: "kimi-web", serveUrl: "http://127.0.0.1:1" } } }));
    const rows = await collectRows({
      registryPath: regPath,
      readRegistryFn: readRegistry,
      ...fakeDeps({
        probeResults: { "kimi-web@default": { distribution: "kimi-web", version: "2.7.2", binaryPath: "kimi.exe", fingerprint: "v1-x", verified: true, reason: null } },
        distTags: { "@moonshot-ai/kimi-code": { tags: null, reason: "npm 查询退出码 1: network offline" } },
      }),
    });
    const kimiRow = rows.find((r) => r.backend === "kimi-web");
    assert.equal(kimiRow.conclusion, "unknown");
    assert.ok(kimiRow.notes.some((n) => n.includes("服务身份未确认")));
    assert.ok(kimiRow.notes.some((n) => n.includes("network offline")));
    // 闭集其余成员出"无配置席位"行（覆盖面不缩水），且不探（PATH 不代表配置对象）
    const codexRow = rows.find((r) => r.backend === "codex");
    assert.equal(codexRow.target, "(无配置席位)");
    assert.equal(codexRow.conclusion, "unknown");
    assert.deepEqual(codexRow.seats, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectRows: claude-code 参照渠道映射内 → 结论照常给、只比声明跟随的 tag、备注标注可比已确认", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-hinv-"));
  try {
    const regPath = join(dir, "agents.json");
    writeFileSync(regPath, JSON.stringify({ agents: { opus: { backend: "claude-code" } } }));
    const rows = await collectRows({
      registryPath: regPath,
      readRegistryFn: readRegistry,
      ...fakeDeps({
        probeResults: { "claude-code@default": { distribution: "claude", version: "2.1.330", binaryPath: "claude.exe", fingerprint: "v1-x", verified: true, reason: null } },
        distTags: { "@anthropic-ai/claude-code": { tags: { latest: "2.1.330", stable: "2.1.323" } } },
      }),
    });
    const row = rows.find((r) => r.backend === "claude-code");
    assert.equal(row.latestVersion, "2.1.330");
    assert.equal(row.latestSource, "npm dist-tag latest (@anthropic-ai/claude-code)");
    assert.equal(row.conclusion, "latest", "映射内可比已确认，结论照常给");
    assert.ok(row.notes.some((n) => n.includes("可比已确认")), "备注标注参照渠道与可比性依据");
    assert.ok(!row.notes.some((n) => n.includes("stable")), "声明跟随 latest 后 stable/next 不附注（只比该 tag）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectRows: 映射外的跨渠道组合 → 结论 unknown 并写'参照渠道发布了 X，是否落后待确认'", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-hinv-"));
  try {
    const regPath = join(dir, "agents.json");
    writeFileSync(regPath, JSON.stringify({ agents: { sol: { backend: "codex" } } }));
    const rows = await collectRows({
      registryPath: regPath,
      readRegistryFn: readRegistry,
      ...fakeDeps({
        probeResults: { "codex@default": { distribution: "codex", version: "0.170.0", binaryPath: "codex.exe", fingerprint: "v1-x", verified: true, reason: null } },
        distTags: { "@openai/codex": { tags: { latest: "0.171.0" } } },
      }),
      crossChannelFn: () => ({ followTag: null, note: null, conclusive: false }),
    });
    const row = rows.find((r) => r.backend === "codex");
    assert.equal(row.conclusion, "unknown", "可比未确认不落 latest/behind");
    assert.ok(row.notes.some((n) => n.includes("参照渠道发布了 0.171.0")), "注记携带参照渠道实际发布值");
    assert.ok(row.notes.some((n) => n.includes("是否落后待确认")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 渲染 ----

test("renderText/renderJson: 同样的事实两种形状（表含六列结论三档；json 带 registry/rows）", () => {
  const rows = [{
    backend: "codex", target: "codex.exe", seats: ["sol"], anchorAgentId: "sol",
    localVersion: "0.170.0", localVerified: true, latestVersion: "0.171.0",
    latestSource: "npm dist-tag latest (@openai/codex)", conclusion: "behind",
    notes: ["席位: sol"],
  }];
  const text = renderText(rows, { registry: "config/agents.json" });
  for (const cell of ["codex", "codex.exe", "0.170.0", "0.171.0", "behind", "席位: sol"]) {
    assert.ok(text.includes(cell), `表缺 ${cell}`);
  }
  const parsed = JSON.parse(renderJson(rows, { registry: "config/agents.example.json" }));
  assert.equal(parsed.registry, "config/agents.example.json");
  assert.equal(typeof parsed.generatedAt, "string");
  assert.deepEqual(parsed.rows, rows);
});

// ---- CLI 接线 ----

test("main: --help → stdout 用法 + exit 0；缺 registry 文件 → stderr 一行说明 + exit 1（零探测）", async () => {
  const out = [];
  const err = [];
  const streams = { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } };
  assert.equal(await main(["--help"], streams), 0);
  assert.match(out.join(""), /--registry/);

  const missing = await main(["--registry", join(tmpdir(), "wao-hinv-missing-", "no-such-registry.json")], streams);
  assert.equal(missing, 1);
  assert.match(err.join(""), /registry 不可读/);
});

test("main: 未知 flag → 用法错误 exit 1；--format json 走 JSON 输出（deps 注入，零真实探测）", async () => {
  const out = [];
  const err = [];
  const streams = { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } };
  assert.equal(await main(["--wat"], streams), 1);
  assert.match(err.join(""), /unknown flag: --wat/);

  const dir = mkdtempSync(join(tmpdir(), "wao-hinv-"));
  try {
    const regPath = join(dir, "agents.json");
    writeFileSync(regPath, JSON.stringify({ agents: { sol: { backend: "codex" } } }));
    const probeCalls = [];
    const code = await main(["--registry", regPath, "--format", "json"], {
      ...streams,
      probeFn: async (input) => { probeCalls.push(input); return { distribution: "codex", version: "0.171.0", binaryPath: "codex.exe", fingerprint: "v1-x", verified: true, reason: null }; },
      npmViewFn: () => ({ tags: { latest: "0.171.0" }, reason: null }),
      readUpdaterFn: () => ({ conclusion: null, reason: "n/a" }),
      productVersionFn: () => ({ version: null, reason: "n/a" }),
      hashFn: () => ({ hash: null, reason: null }),
    });
    assert.equal(code, 0);
    assert.equal(probeCalls.length, 1, "同目标恰一次探针（去重后单组单探）");
    assert.equal(probeCalls[0].backendName, "codex");
    const parsed = JSON.parse(out.join(""));
    assert.equal(parsed.rows[0].conclusion, "latest");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
