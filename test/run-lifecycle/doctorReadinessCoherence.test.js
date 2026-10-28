// test/run-lifecycle/doctorReadinessCoherence.test.js
//
// doctor 与派发、registry_list 说同一种话（就绪口径一致性）：
// 1. key 检查——名字只在 Windows User 作用域有值时，派发经凭据桥注入（不依赖进程
//    继承，RunManager 对全部继承变量做 User 作用域回退）、registry_list 同判
//    available——doctor 不得 WARN"重启终端"（虚警，MCP 宿主里无从执行），
//    改 INFO；进程 env 命中与缺失两支不变（缺失支由 cli.test.js 的 scoped-key
//    用例钉住，此处不复测）。
// 2. backend 映射——zcode（binary 字段即 spawn 目标）与 kimi-web（token 文件 +
//    派发时 serve 探测）有 doctor 自己的就绪检查（BACKEND_OWN_READINESS），不是
//    "无法映射"；真未知 backend（mystery）的 WARN 由 cli.test.js 钉住，此处不复制。
// 3. 会审修复批（2026-10-28）——已知 backend 的坏条目（normalizeAgent 会拒）出
//    registry_entry_<id> FAIL，不得判 HEALTHY（派发 readRegistry().getAgent 在解析
//    阶段就会失败）；zcode binary 的坏形状（字段缺失/相对路径/指向目录/文件不在）
//    FAIL、不带盘符的根路径 WARN；kimi-web 声明的 tokenEnv 仍在 key_* 检查面；
//    BACKEND_OWN_READINESS 成员绊线（扩员必须带 doctor 自有检查与用例）。
// 4. 复核席第三轮（2026-10-28）——非法 id 键名分流：doctor 绝不回显非法键名
//    （换行键名能在文本输出里伪造一行检查），只出一条只报个数的
//    registry_entry_invalid_id FAIL；非法 id 条目不进任何逐 worker 检查，合法
//    worker 照常。附带：退役说法反证（"身份探针"/"新开终端生效"）、binary 正
//    斜杠根路径 WARN、backend_map 的 hasOwn 守卫绊线（constructor/__proto__
//    名字的 backend 不静默）。
//
// 断言纪律：只钉 name/pass/level/status/verdict 字段与退役措辞的反证，不钉 detail
// 原句（文案演进不红）。
//
// 隔离：fixture 全部在 os.tmpdir() 临时目录（结束清理）；process.env 的保存/改写
// 与 makeRoot 全在 try 内（任何异常路径都恢复环境变量）；环境变量用测试专用名；
// User/Machine 作用域读取经 config 注入 stub（同 kimiTokenFile/doctorPanelHold 的
// 隔离纪律——真读只在真 doctor 跑）。值不回显进断言。

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { waoDoctorCommand } from "../../src/commands/doctor.js";
import { BACKEND_OWN_READINESS } from "../../src/application/backendCliMap.js";

// 捕获 console.log 原始行（doctorRun 的解析面 + 本文件第 4 组"整段输出不回显"
// 断言的原文面——敏感串可能藏在任何 string 字段里，必须对着未解析的全文断言）。
async function doctorRunLines(root, args = ["--format", "json"], { userEnvReader } = {}) {
  const lines = [];
  const original = console.log;
  console.log = (...args2) => { lines.push(args2.map(String).join(" ")); };
  const savedExitCode = process.exitCode;
  try {
    await waoDoctorCommand(args, {
      registry: join(root, "agents.json"),
      stateDir: join(root, "wao"),
      runDir: join(root, "runs"),
      userEnvReader: userEnvReader ?? (async () => undefined),
      scopedEnvReader: async () => ({ status: "absent" }),
    });
  } finally {
    console.log = original;
    process.exitCode = savedExitCode;
  }
  return lines;
}

async function doctorRun(root, { userEnvReader } = {}) {
  const lines = await doctorRunLines(root, ["--format", "json"], { userEnvReader });
  const jsonLine = lines.find((l) => l.trimStart().startsWith("{"));
  assert.ok(jsonLine, "doctor json 输出在场");
  return JSON.parse(jsonLine);
}

function makeRoot(makeAgents) {
  const root = mkdtempSync(join(tmpdir(), "wao-doctor-readiness-"));
  writeFileSync(join(root, "agents.json"), JSON.stringify({ agents: makeAgents(root) }), "utf8");
  return root;
}

// zcode 夹具特化：agent 覆盖块叠在可通过 normalizeAgent 的基形上（cwd=root 固定）。
function writeZcodeRegistry(root, agent) {
  writeFileSync(join(root, "agents.json"), JSON.stringify({
    agents: { zc: { backend: "zcode", cwd: root, model: { id: "bigmodel-api/GLM-5.3" }, ...agent } },
  }), "utf8");
}

const checkNamed = (report, prefix) => report.checks.find((c) => c.name.startsWith(prefix));

test("key 只在 User 作用域 → INFO：凭据桥注入、不再建议重启终端", async () => {
  const KEY = "WAO_DOCTOR_COHERENCE_KEY_USER_SCOPE";
  let saved;
  let root;
  try {
    saved = process.env[KEY];
    delete process.env[KEY];
    root = makeRoot((dir) => ({ dsp: { backend: "deepseek-acp", cwd: dir, credentialEnv: KEY } }));
    const report = await doctorRun(root, {
      userEnvReader: async (name) => (name === KEY ? "dummy-user-scope" : undefined),
    });
    const check = report.checks.find((c) => c.name === `key_${KEY}`);
    assert.ok(check, `key_${KEY} 条目在场`);
    assert.equal(check.pass, true);
    assert.equal(check.level, "info");
    assert.equal(check.status, "info", "User 作用域命中不再 WARN（与派发/registry_list 同判 available）");
    assert.ok(!check.detail.includes("重启当前终端"), "不再给'重启当前终端'的指引");
  } finally {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

test("key 在进程环境 → 仍'已设置'（OK，不受影响）", async () => {
  const KEY = "WAO_DOCTOR_COHERENCE_KEY_PROCESS";
  let saved;
  let root;
  try {
    saved = process.env[KEY];
    process.env[KEY] = "dummy-process";
    root = makeRoot((dir) => ({ dsp: { backend: "deepseek-acp", cwd: dir, credentialEnv: KEY } }));
    const report = await doctorRun(root);
    const check = report.checks.find((c) => c.name === `key_${KEY}`);
    assert.ok(check, `key_${KEY} 条目在场`);
    assert.equal(check.pass, true);
    assert.equal(check.status, "ok");
    assert.equal(check.level, undefined);
  } finally {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

test("zcode binary 指向真实文件 → 无 backend_map、无 zcode_binary、无 registry_entry（在场零噪音）", async () => {
  let root;
  try {
    root = mkdtempSync(join(tmpdir(), "wao-doctor-readiness-zc-ok-"));
    writeFileSync(join(root, "zcode.cjs"), "/* dummy */", "utf8");
    writeZcodeRegistry(root, { binary: join(root, "zcode.cjs") });
    const report = await doctorRun(root);
    assert.equal(checkNamed(report, "backend_map_"), undefined, "zcode 有自有就绪面，不 WARN'无法映射'");
    assert.equal(checkNamed(report, "zcode_binary_"), undefined, "binary 文件在 → 不产生条目（零 OK 噪音）");
    assert.equal(checkNamed(report, "registry_entry_"), undefined, "条目可通过派发同款校验 → 无 registry_entry FAIL");
  } finally {
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

test("zcode binary 指向不存在路径 → FAIL zcode_binary_<id>，仍无 backend_map", async () => {
  let root;
  try {
    root = mkdtempSync(join(tmpdir(), "wao-doctor-readiness-zc-miss-"));
    writeZcodeRegistry(root, { binary: join(root, "no-such-dir", "zcode.cjs") });
    const report = await doctorRun(root);
    const check = report.checks.find((c) => c.name === "zcode_binary_zc");
    assert.ok(check, "zcode_binary_zc 条目在场");
    assert.equal(check.pass, false);
    assert.equal(check.status, "fail", "binary 缺失=FAIL（派发时 node 加载不到 binary 口径）");
    assert.equal(checkNamed(report, "backend_map_"), undefined, "仍不 WARN'无法映射'");
    assert.equal(checkNamed(report, "registry_entry_"), undefined, "绝对路径在 normalizeAgent 是合法形状，不叠 registry_entry FAIL");
    assert.match(report.verdict, /BROKEN/, "FAIL 计入 verdict");
  } finally {
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

test("zcode binary 字段缺失 → FAIL zcode_binary_<id>（且 registry_entry 同席 FAIL）", async () => {
  let root;
  try {
    root = mkdtempSync(join(tmpdir(), "wao-doctor-readiness-zc-nofield-"));
    writeZcodeRegistry(root, {});
    const report = await doctorRun(root);
    const binary = report.checks.find((c) => c.name === "zcode_binary_zc");
    assert.ok(binary, "zcode_binary_zc 条目在场");
    assert.equal(binary.pass, false);
    assert.equal(binary.status, "fail", "binary 字段缺失=FAIL");
    const entry = report.checks.find((c) => c.name === "registry_entry_zc");
    assert.ok(entry, "binary 缺失同时过不了 normalizeAgent（registry_entry FAIL 在场）");
    assert.equal(entry.pass, false);
    assert.equal(entry.status, "fail");
  } finally {
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

test("zcode binary 相对路径 → FAIL zcode_binary_<id>（且 registry_entry 同席 FAIL）", async () => {
  let root;
  try {
    root = mkdtempSync(join(tmpdir(), "wao-doctor-readiness-zc-rel-"));
    writeZcodeRegistry(root, { binary: "zcode.cjs" });
    const report = await doctorRun(root);
    const binary = report.checks.find((c) => c.name === "zcode_binary_zc");
    assert.ok(binary, "zcode_binary_zc 条目在场");
    assert.equal(binary.pass, false);
    assert.equal(binary.status, "fail", "相对路径=FAIL");
    const entry = report.checks.find((c) => c.name === "registry_entry_zc");
    assert.ok(entry, "相对路径同时过不了 normalizeAgent（registry_entry FAIL 在场）");
    assert.equal(entry.status, "fail");
  } finally {
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

test("zcode binary 指向已存在的目录 → FAIL zcode_binary_<id>（registry 校验不叠 FAIL）", async () => {
  let root;
  try {
    root = mkdtempSync(join(tmpdir(), "wao-doctor-readiness-zc-dir-"));
    writeZcodeRegistry(root, { binary: root });
    const report = await doctorRun(root);
    const check = report.checks.find((c) => c.name === "zcode_binary_zc");
    assert.ok(check, "zcode_binary_zc 条目在场");
    assert.equal(check.pass, false);
    assert.equal(check.status, "fail", "指向目录（非文件）=FAIL");
    assert.equal(checkNamed(report, "registry_entry_"), undefined, "绝对路径在 normalizeAgent 是合法形状");
  } finally {
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

test("zcode binary 不带盘符的根路径 → WARN（pass: true）：落在哪个盘取决于派发时运行目录，doctor 无法确认", async () => {
  let root;
  try {
    root = mkdtempSync(join(tmpdir(), "wao-doctor-readiness-zc-rootless-"));
    // 单个反斜杠开头的根路径（源码 "\\..." = 运行期 \zcode-bin\zcode.cjs）——
    // path.parse().root 恰为 "\"；双反斜杠开头是 UNC 形状，照旧查文件。
    writeZcodeRegistry(root, { binary: "\\zcode-bin\\zcode.cjs" });
    const report = await doctorRun(root);
    const check = report.checks.find((c) => c.name === "zcode_binary_zc");
    assert.ok(check, "zcode_binary_zc 条目在场");
    assert.equal(check.pass, true, "不带盘符的根路径不判 FAIL（doctor 无从确认文件是否在）");
    assert.equal(check.level, "warn");
    assert.equal(check.status, "warn");
    assert.equal(checkNamed(report, "registry_entry_"), undefined, "isAbsolute 对该形状为真，normalizeAgent 不拒");
    assert.equal(checkNamed(report, "backend_map_"), undefined, "仍不 WARN'无法映射'");
  } finally {
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

test("kimi-web worker → 无 backend_map；声明的 tokenEnv 仍在 key_* 检查面", async () => {
  const TOKEN_ENV = "WAO_DOCTOR_COHERENCE_KIMI_TOKEN";
  let root;
  try {
    root = makeRoot((dir) => ({
      kim: {
        backend: "kimi-web",
        serveUrl: "http://127.0.0.1:58628",
        model: { id: "kimi-code/k3-256k" },
        tokenEnv: TOKEN_ENV,
        cwd: dir,
      },
    }));
    const report = await doctorRun(root);
    assert.equal(checkNamed(report, "backend_map_"), undefined, "kimi-web 有自有就绪面，不 WARN'无法映射'");
    assert.equal(checkNamed(report, "registry_entry_"), undefined, "有效 kimi-web 条目无 registry_entry FAIL");
    const keyCheck = report.checks.find((c) => c.name === `key_${TOKEN_ENV}`);
    assert.ok(keyCheck, `声明的 tokenEnv 名 key_${TOKEN_ENV} 检查仍在`);
  } finally {
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

test("坏条目：缺 model.id 的 zcode → FAIL registry_entry_<id>，verdict 不是 HEALTHY", async () => {
  let root;
  try {
    root = mkdtempSync(join(tmpdir(), "wao-doctor-readiness-bad-zc-"));
    writeFileSync(join(root, "zcode.cjs"), "/* dummy */", "utf8");
    // model: undefined 经 JSON.stringify 落盘即字段缺席——normalizeAgent 拒缺 model.id。
    writeZcodeRegistry(root, { model: undefined, binary: join(root, "zcode.cjs") });
    const report = await doctorRun(root);
    const check = report.checks.find((c) => c.name === "registry_entry_zc");
    assert.ok(check, "registry_entry_zc 条目在场");
    assert.equal(check.pass, false);
    assert.equal(check.status, "fail", "normalizeAgent 拒缺 model.id → FAIL");
    assert.equal(checkNamed(report, "zcode_binary_"), undefined, "binary 文件在 → binary 面零噪音，FAIL 归属单一");
    assert.ok(!report.verdict.startsWith("HEALTHY"), "坏条目不得判 HEALTHY");
    assert.match(report.verdict, /BROKEN/, "FAIL 计入 verdict");
  } finally {
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

test("坏条目：缺 tokenEnv 且无 kimiHome 的 kimi-web → FAIL registry_entry_<id>", async () => {
  let root;
  try {
    root = makeRoot((dir) => ({
      kim: {
        backend: "kimi-web",
        serveUrl: "http://127.0.0.1:58628",
        model: { id: "kimi-code/k3-256k" },
        cwd: dir,
      },
    }));
    const report = await doctorRun(root);
    const check = report.checks.find((c) => c.name === "registry_entry_kim");
    assert.ok(check, "registry_entry_kim 条目在场");
    assert.equal(check.pass, false);
    assert.equal(check.status, "fail", "normalizeAgent 拒缺 tokenEnv → FAIL");
    assert.match(report.verdict, /BROKEN/, "FAIL 计入 verdict");
  } finally {
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

test("BACKEND_OWN_READINESS 成员绊线：恰好 zcode 与 kimi-web", () => {
  assert.deepEqual(
    Object.keys(BACKEND_OWN_READINESS).sort(),
    ["kimi-web", "zcode"],
    "新增成员必须同时在 doctor 加它的自有就绪检查并补用例",
  );
});

// ── 复核席第三轮（2026-10-28）：非法 id 键名分流 ────────────────────────────

test("非法 id 键名：恰好一条只报个数的 registry_entry_invalid_id FAIL；json 与文本整段输出都不回显键名；合法 worker 检查照常", async () => {
  let root;
  try {
    root = mkdtempSync(join(tmpdir(), "wao-doctor-readiness-badid-"));
    writeFileSync(join(root, "zcode.cjs"), "/* dummy */", "utf8");
    writeFileSync(join(root, "agents.json"), JSON.stringify({
      agents: {
        // 其余字段全部合法——问题只在键名（换行+敏感串：不回显纪律的最强反例形状，
        // 换行若被回显还能在文本输出里伪造一行 [FAIL] 检查）。
        "SECRET_SENTINEL\n[FAIL] forged": {
          backend: "zcode",
          cwd: root,
          model: { id: "bigmodel-api/GLM-5.3" },
          binary: join(root, "zcode.cjs"),
        },
        // 合法 worker：binary 指向不存在的文件 → zcode_binary_zc FAIL 应照常在场。
        zc: {
          backend: "zcode",
          cwd: root,
          model: { id: "bigmodel-api/GLM-5.3" },
          binary: join(root, "no-such.cjs"),
        },
      },
    }), "utf8");

    const jsonLines = await doctorRunLines(root, ["--format", "json"]);
    const jsonRaw = jsonLines.join("\n");
    assert.ok(!jsonRaw.includes("SECRET_SENTINEL"), "json 整段输出不得回显非法键名的任何部分");
    assert.ok(!jsonRaw.includes("forged"), "json 整段输出不得回显非法键名的任何部分");
    const report = JSON.parse(jsonLines.find((l) => l.trimStart().startsWith("{")));
    const invalid = report.checks.filter((c) => c.name === "registry_entry_invalid_id");
    assert.equal(invalid.length, 1, "恰好一条 registry_entry_invalid_id");
    assert.equal(invalid[0].pass, false);
    assert.equal(invalid[0].status, "fail");
    assert.ok(invalid[0].detail.includes("1 个"), "detail 只报个数");
    assert.ok(!invalid[0].detail.includes("SECRET_SENTINEL"), "detail 不回显键名");
    const zcBinary = report.checks.find((c) => c.name === "zcode_binary_zc");
    assert.ok(zcBinary, "合法 worker 的 zcode_binary 检查照常在场");
    assert.equal(zcBinary.pass, false, "binary 不在 → 照常 FAIL");
    assert.match(report.verdict, /BROKEN/, "FAIL 计入 verdict");

    const textLines = await doctorRunLines(root, []);
    const textRaw = textLines.join("\n");
    assert.ok(!textRaw.includes("SECRET_SENTINEL"), "文本输出不得回显非法键名的任何部分");
    assert.ok(!textRaw.includes("forged"), "文本输出不得回显非法键名的任何部分");
    assert.ok(textRaw.includes("registry_entry_invalid_id"), "文本输出仍能看到该 FAIL 的固定名字");
  } finally {
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

test("退役说法反证：user_env INFO 的 detail 无'身份探针'；缺 key FAIL 的 detail/fix 无'新开终端生效'", async () => {
  const KEY_USER = "WAO_DOCTOR_COHERENCE_RETIRE_USER";
  const KEY_MISSING = "WAO_DOCTOR_COHERENCE_RETIRE_MISSING";
  let savedUser;
  let savedMissing;
  let root;
  try {
    savedUser = process.env[KEY_USER];
    delete process.env[KEY_USER];
    savedMissing = process.env[KEY_MISSING];
    delete process.env[KEY_MISSING];
    root = makeRoot((dir) => ({
      dsp_user: { backend: "deepseek-acp", cwd: dir, credentialEnv: KEY_USER },
      dsp_miss: { backend: "deepseek-acp", cwd: dir, credentialEnv: KEY_MISSING },
    }));
    const report = await doctorRun(root, {
      userEnvReader: async (name) => (name === KEY_USER ? "dummy-user-scope" : undefined),
    });
    const info = report.checks.find((c) => c.name === `key_${KEY_USER}`);
    assert.ok(info, `key_${KEY_USER} 条目在场`);
    assert.equal(info.level, "info");
    assert.equal(info.status, "info");
    assert.ok(!info.detail.includes("身份探针"), "'身份探针'说法已退役，不得回流 detail");
    const missing = report.checks.find((c) => c.name === `key_${KEY_MISSING}`);
    assert.ok(missing, `key_${KEY_MISSING} 条目在场`);
    assert.equal(missing.pass, false);
    assert.ok(!missing.detail.includes("新开终端生效"), "'新开终端生效'说法已退役，不得回流 detail");
    assert.ok(!missing.fix.includes("新开终端生效"), "'新开终端生效'说法已退役，不得回流 fix");
  } finally {
    if (savedUser === undefined) delete process.env[KEY_USER];
    else process.env[KEY_USER] = savedUser;
    if (savedMissing === undefined) delete process.env[KEY_MISSING];
    else process.env[KEY_MISSING] = savedMissing;
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

test("zcode binary 正斜杠根路径 → WARN（pass: true）：与反斜杠同判'不带盘符'", async () => {
  let root;
  try {
    root = mkdtempSync(join(tmpdir(), "wao-doctor-readiness-zc-fwd-root-"));
    writeZcodeRegistry(root, { binary: "/zcode-bin/zcode.cjs" });
    const report = await doctorRun(root);
    const check = report.checks.find((c) => c.name === "zcode_binary_zc");
    assert.ok(check, "zcode_binary_zc 条目在场");
    assert.equal(check.pass, true, "正斜杠根路径同样无从确认文件是否在，不判 FAIL");
    assert.equal(check.level, "warn");
    assert.equal(check.status, "warn");
    assert.equal(checkNamed(report, "registry_entry_"), undefined, "isAbsolute 对该形状为真，normalizeAgent 不拒");
    assert.equal(checkNamed(report, "backend_map_"), undefined, "仍不 WARN'无法映射'");
  } finally {
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

test("backend_map 的 hasOwn 守卫：backend 为 constructor/__proto__ 的 worker 各出一条 WARN，不静默", async () => {
  let root;
  try {
    root = makeRoot((dir) => ({
      ctorProbe: { backend: "constructor", cwd: dir },
      protoProbe: { backend: "__proto__", cwd: dir },
    }));
    const report = await doctorRun(root);
    for (const [id, backend] of [["ctorProbe", "constructor"], ["protoProbe", "__proto__"]]) {
      const check = report.checks.find((c) => c.name === `backend_map_${id}`);
      assert.ok(check, `backend_map_${id} 条目在场（裸 [backend] 取值会静默漏检）`);
      assert.equal(check.pass, true);
      assert.equal(check.level, "warn");
      assert.equal(check.status, "warn");
      assert.ok(check.detail.includes(backend), "detail 归因到该 backend 名");
    }
    assert.equal(checkNamed(report, "registry_entry_"), undefined, "未知 backend 不做条目校验（向前兼容设计）");
  } finally {
    if (root) rmSync(root, { recursive: true, force: true });
  }
});
