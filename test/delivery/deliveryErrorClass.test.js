// test/delivery/deliveryErrorClass.test.js
//
// 交付打包失败的安全错误类别分类器（src/deliveryErrorClass.js）及其投影面：
//   - 分类器：每个闭集类别的触发与不触发、未知错误 → null、返回值只出自
//     冻结闭集、错误消息里的假路径/假秘密不出现在任何输出；
//   - index.lock 探测：os.tmpdir() 下真实 git 仓库 + 关联工作树，锁在 →
//     git_index_locked，锁不在 → 不判该类（探测失败同样不判）；
//   - runManager：注入抛 EBUSY 的 packageDeliveryFn，run.delivery_failed 与
//     run.error 都带 errorClass:"file_locked" 且消息仍是脱敏摘要；类别为
//     null 时载荷里没有 errorClass 键；
//   - diagnosis：闭集 errorClass → 固定文案事实；未知值不出附加事实；
//     事实文案键集与 DELIVERY_ERROR_CLASSES 对账。
//
// 测试仓库一律建在 os.tmpdir() 下；run 目录同样在 tmpdir 根下（不指向仓库
// 相对 runs/）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync, execFileSync } from "node:child_process";

import { classifyDeliveryError, DELIVERY_ERROR_CLASSES } from "../../src/deliveryErrorClass.js";
import { diagnoseFailure, DELIVERY_ERROR_CLASS_FACTS } from "../../src/diagnosis.js";
import { Run } from "../../src/runManager.js";
import { JsonlTranscript, readTranscript } from "../../src/transcript.js";

// 假泄露标记：放进错误消息原文，断言不进入任何分类/事件输出。
// "test-secret" 拼写同时落在脱敏门控的 fixture 豁免词上（非真凭证形状）。
const FAKE_PATH = "D:/fake/worker/secret-zone/plan.md";
const FAKE_SECRET = "wao-test-secret-ABC123XYZ";

function cleanupSync(dir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      if (attempt === 4) return;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, false, 50 * (attempt + 1));
    }
  }
}

// ===== 分类器：闭集与触发 =====

test("DEC-01: DELIVERY_ERROR_CLASSES 是冻结闭集，成员恰为七个已知类别", () => {
  assert.equal(Object.isFrozen(DELIVERY_ERROR_CLASSES), true);
  assert.deepEqual([...DELIVERY_ERROR_CLASSES], [
    "git_index_locked",
    "file_locked",
    "permission_denied",
    "disk_full",
    "git_spawn_failed",
    "git_timeout",
    "git_command_failed",
  ]);
});

test("DEC-02: 每个类别的触发形状", () => {
  assert.deepEqual(classifyDeliveryError({ code: "ENOENT", syscall: "spawn git" }), { errorClass: "git_spawn_failed" });
  // execFileSync 在 Windows 上的启动失败形状是 spawnSync
  assert.deepEqual(classifyDeliveryError({ code: "ENOENT", syscall: "spawnSync git" }), { errorClass: "git_spawn_failed" });
  assert.deepEqual(classifyDeliveryError({ code: "ETIMEDOUT" }), { errorClass: "git_timeout" });
  assert.deepEqual(classifyDeliveryError({ signal: "SIGTERM" }), { errorClass: "git_timeout" });
  assert.deepEqual(classifyDeliveryError({ code: "ENOSPC", syscall: "open" }), { errorClass: "disk_full" });
  assert.deepEqual(classifyDeliveryError({ code: "EACCES", syscall: "open" }), { errorClass: "permission_denied" });
  assert.deepEqual(classifyDeliveryError({ code: "EBUSY", syscall: "unlink" }), { errorClass: "file_locked" });
  assert.deepEqual(classifyDeliveryError({ code: "EPERM", syscall: "open" }), { errorClass: "file_locked" });
  // 无 worktreePath 时 status 类错误直接落 git_command_failed（index.lock 无从探测）
  assert.deepEqual(classifyDeliveryError({ status: 128 }), { errorClass: "git_command_failed", gitExitStatus: 128 });
  assert.deepEqual(classifyDeliveryError({ status: -2 }), { errorClass: "git_command_failed", gitExitStatus: -2 });
});

test("DEC-03: 不触发形状与未知错误 → null", () => {
  assert.equal(classifyDeliveryError(new Error("plain failure")), null);
  assert.equal(classifyDeliveryError({ message: "no structured props" }), null);
  assert.equal(classifyDeliveryError({ status: 0 }), null, "status 0 不是非零退出");
  assert.equal(classifyDeliveryError({ status: 1.5 }), null, "非整数 status 不算退出码");
  assert.equal(classifyDeliveryError({ status: "128" }), null, "字符串 status 不算退出码");
  assert.equal(classifyDeliveryError({ signal: "" }), null, "空 signal 不算被杀");
  assert.equal(classifyDeliveryError(null), null);
  assert.equal(classifyDeliveryError(undefined), null);
  assert.equal(classifyDeliveryError("string error"), null);
  assert.equal(classifyDeliveryError(42), null);
});

test("DEC-04: spawn 判定优先于 fs 错误码（spawn 引起的 EACCES/EPERM 不判权限/文件锁）", () => {
  assert.deepEqual(
    classifyDeliveryError({ code: "EACCES", syscall: "spawn git" }),
    { errorClass: "git_spawn_failed" },
  );
  assert.deepEqual(
    classifyDeliveryError({ code: "EPERM", syscall: "spawnSync git" }),
    { errorClass: "git_spawn_failed" },
  );
});

test("DEC-05: 包装错误按 cause 链下钻；环状 cause 不挂死", () => {
  const wrapped = Object.assign(new Error("wrapper"), { cause: { code: "ENOSPC" } });
  assert.deepEqual(classifyDeliveryError(wrapped), { errorClass: "disk_full" });
  const deep = Object.assign(new Error("outer"), {
    cause: Object.assign(new Error("mid"), { cause: { status: 128 } }),
  });
  assert.deepEqual(classifyDeliveryError(deep), { errorClass: "git_command_failed", gitExitStatus: 128 });
  // cause 非对象（字符串）不构成下钻
  assert.equal(classifyDeliveryError(Object.assign(new Error("w"), { cause: "ENOENT" })), null);
  // 环状 cause：深度上限兜底，分类结果为 null 而不是死循环
  const cyclic = { message: "cycle" };
  cyclic.cause = cyclic;
  assert.equal(classifyDeliveryError(cyclic), null);
});

test("DEC-06: 返回值只出自闭集；错误消息里的假路径/假秘密不出现在任何输出", () => {
  const shapes = [
    { code: "ENOENT", syscall: "spawn git" },
    { code: "EACCES", syscall: "spawnSync git" },
    { code: "ETIMEDOUT" },
    { signal: "SIGKILL" },
    { code: "ENOSPC", message: `disk full at ${FAKE_PATH}` },
    { code: "EACCES", message: `denied token=${FAKE_SECRET}` },
    { code: "EBUSY" },
    { code: "EPERM" },
    { status: 128 },
    { status: 1 },
    { status: -2 },
    Object.assign(new Error(`git failed at ${FAKE_PATH} token=${FAKE_SECRET}`), { status: 128 }),
    { message: `nothing but ${FAKE_SECRET}` },
    {},
  ];
  for (const shape of shapes) {
    const r = classifyDeliveryError(shape);
    assert.ok(r === null || DELIVERY_ERROR_CLASSES.includes(r.errorClass),
      `返回值只能是 null 或闭集成员：${JSON.stringify(r)}`);
    if (r !== null) {
      assert.ok(!JSON.stringify(r).includes(FAKE_PATH), "分类结果不回显错误消息里的路径");
      assert.ok(!JSON.stringify(r).includes(FAKE_SECRET), "分类结果不回显错误消息里的秘密");
    }
  }
});

// ===== index.lock 探测：真实 git 仓库 + 关联工作树（os.tmpdir() 下） =====

function makeGitRepo(dir) {
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "test@test"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "test"', { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "# t\n", "utf8");
  execSync("git add README.md", { cwd: dir, stdio: "ignore" });
  execSync("git commit -m init", { cwd: dir, stdio: "ignore" });
}

test("DEC-07: 关联工作树 git dir 下 index.lock 在场 → git_index_locked；锁不在 → 不判该类", () => {
  const repo = mkdtempSync(join(tmpdir(), "wao-dec-lock-"));
  try {
    makeGitRepo(repo);
    const wt = join(repo, "wt-link");
    execSync(`git worktree add "${wt}" -b wao/dec_probe`, { cwd: repo, stdio: "ignore" });
    // 关联工作树的 .git 是文件；解析其 gitdir 指针拿 admin dir（与探测实现同源事实）
    const dotGit = readFileSync(join(wt, ".git"), "utf8");
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(dotGit);
    assert.ok(m, "关联工作树 .git 文件必须可解析出 gitdir");
    const gitDir = m[1];
    const statusErr = { status: 128 };

    // 锁不在 → git_command_failed（不是 git_index_locked）
    assert.deepEqual(classifyDeliveryError(statusErr, { worktreePath: wt }),
      { errorClass: "git_command_failed", gitExitStatus: 128 });

    // 造出 index.lock → git_index_locked
    writeFileSync(join(gitDir, "index.lock"), "", "utf8");
    assert.deepEqual(classifyDeliveryError(statusErr, { worktreePath: wt }),
      { errorClass: "git_index_locked" });

    // 锁移除 → 回到 git_command_failed
    rmSync(join(gitDir, "index.lock"), { force: true });
    assert.deepEqual(classifyDeliveryError(statusErr, { worktreePath: wt }),
      { errorClass: "git_command_failed", gitExitStatus: 128 });
  } finally {
    cleanupSync(repo);
  }
});

test("DEC-08: 主检出形状（.git 目录）同样可探测；探测失败不判该类", () => {
  const repo = mkdtempSync(join(tmpdir(), "wao-dec-primary-"));
  const scratch = mkdtempSync(join(tmpdir(), "wao-dec-scratch-"));
  try {
    makeGitRepo(repo);
    const statusErr = { status: 128 };
    writeFileSync(join(repo, ".git", "index.lock"), "", "utf8");
    assert.deepEqual(classifyDeliveryError(statusErr, { worktreePath: repo }),
      { errorClass: "git_index_locked" });
    rmSync(join(repo, ".git", "index.lock"), { force: true });

    // worktreePath 不存在 / .git 内容不是合法 gitdir 指针 / 缺省 —— 探测失败一律不判
    assert.deepEqual(classifyDeliveryError(statusErr, { worktreePath: join(scratch, "no-such-wt") }),
      { errorClass: "git_command_failed", gitExitStatus: 128 });
    const bogus = join(scratch, "bogus-wt");
    mkdirSync(bogus, { recursive: true });
    writeFileSync(join(bogus, ".git"), "not a gitdir pointer\n", "utf8");
    assert.deepEqual(classifyDeliveryError(statusErr, { worktreePath: bogus }),
      { errorClass: "git_command_failed", gitExitStatus: 128 });
    assert.deepEqual(classifyDeliveryError(statusErr, {}),
      { errorClass: "git_command_failed", gitExitStatus: 128 });
    assert.deepEqual(classifyDeliveryError(statusErr),
      { errorClass: "git_command_failed", gitExitStatus: 128 });
  } finally {
    cleanupSync(repo);
    cleanupSync(scratch);
  }
});

// ===== runManager：事件载荷投影 =====

/**
 * 直构交付类 Run（TD-150 fixture 形状）：worker 产出 metrics + done(completed)，
 * 打包器按注入抛错。run 目录在 tmpdir 根下。
 */
async function makeErrorClassFixture(packager) {
  const root = await mkdtemp(join(tmpdir(), "wao-dec-fx-"));
  const runId = "run_dec_fx";
  const runDir = join(root, "runs");
  const transcriptPath = join(runDir, `${runId}.jsonl`);
  const transcript = new JsonlTranscript(transcriptPath, { runId, agentId: "coder_hq" });
  await transcript.append("session.created", {
    backend: "claude-code",
    backendSessionId: "ses_dec",
  });
  const handle = {
    backend: "claude-code",
    backendSessionId: "ses_dec",
    events: async function* () {
      // 首个 active 事件标 running（TD-56），避免裸终态转移被 first-terminal-wins 拒掉。
      yield { kind: "metrics", tokens: { input: 1, output: 0 }, costUsd: 0 };
      yield { kind: "done", reason: "completed" };
    },
    async abort() {},
  };
  const run = new Run({
    runId,
    agentId: "coder_hq",
    agent: { id: "coder_hq", cwd: join(root, "wt") },
    backend: {},
    handle,
    transcript,
    result: {
      backend: "claude-code",
      backendSessionId: "ses_dec",
      messageId: "msg_dec",
      admittedSeq: 1,
    },
    config: { runDir },
    onRemove: () => {},
    initialState: "submitted",
    effectiveCwd: join(root, "wt"),
    deliveryContext: { runId, worktreePath: join(root, "wt") },
    packageDeliveryFn: packager,
  });
  return { root, run, transcriptPath, runId };
}

test("DEC-09: EBUSY 打包失败 → 两事件都带 errorClass:file_locked，消息仍是脱敏摘要，不回显原文", async () => {
  const fx = await makeErrorClassFixture(async () => {
    const err = new Error(`EBUSY: ${FAKE_PATH} is locked (token=${FAKE_SECRET})`);
    err.code = "EBUSY";
    throw err;
  });
  try {
    const result = await fx.run.waitForCompletion({ pollInterval: 1 });
    assert.equal(fx.run.state, "failed");
    assert.equal(result.failed, true);
    assert.equal(result.deliveryError.code, "delivery_error", "无 deliveryCode 的原始异常 → delivery_error（闭集不变）");

    const events = await readTranscript(fx.transcriptPath);
    const df = events.find((e) => e.type === "run.delivery_failed");
    const re = events.find((e) => e.type === "run.error" && e.phase === "delivery");
    assert.ok(df, "必须落 run.delivery_failed");
    assert.ok(re, "必须落 run.error phase=delivery");
    assert.equal(df.errorClass, "file_locked");
    assert.equal(re.errorClass, "file_locked");
    assert.equal(df.deliveryCode, "delivery_error");
    assert.equal(df.message, "delivery packaging error", "未知措辞的消息仍落通用脱敏摘要");
    // 结果对象只透传 code+message（投影面是事件与诊断，不是 deliveryError）
    assert.equal(Object.hasOwn(result.deliveryError, "errorClass"), false);
    // 假路径/假秘密不进任何事件
    assert.ok(!JSON.stringify(events).includes(FAKE_PATH), "事件不含错误消息里的路径");
    assert.ok(!JSON.stringify(events).includes(FAKE_SECRET), "事件不含错误消息里的秘密");
  } finally {
    cleanupSync(fx.root);
  }
});

test("DEC-10: 类别分不出 → 两事件都没有 errorClass 键（absent 非 null）", async () => {
  const fx = await makeErrorClassFixture(async () => {
    throw new Error("mystery failure");
  });
  try {
    const result = await fx.run.waitForCompletion({ pollInterval: 1 });
    assert.equal(result.failed, true);
    const events = await readTranscript(fx.transcriptPath);
    const df = events.find((e) => e.type === "run.delivery_failed");
    const re = events.find((e) => e.type === "run.error" && e.phase === "delivery");
    assert.ok(df && re);
    assert.equal(Object.hasOwn(df, "errorClass"), false, "absent 非 null（仓库惯例）");
    assert.equal(Object.hasOwn(re, "errorClass"), false);
    assert.equal(df.errorClass, undefined);
    assert.equal(df.deliveryCode, "delivery_error");
    assert.equal(df.message, "delivery packaging error");
  } finally {
    cleanupSync(fx.root);
  }
});

// ===== diagnosis：闭集 errorClass → 固定文案事实 =====

const DIAG_RUN_ID = "run_dec_diag";
const DIAG_AGENT = "coder_hq";
const DIAG_TS = "2026-10-14T00:00:00.000Z";

function diagEvents(extra) {
  return [
    { type: "run.state_change", to: "completed", reason: "done", runId: DIAG_RUN_ID, agentId: DIAG_AGENT, ts: DIAG_TS, seq: 1 },
    {
      type: "run.delivery_failed", deliveryCode: "delivery_error", message: "delivery packaging error",
      ...extra, runId: DIAG_RUN_ID, agentId: DIAG_AGENT, ts: DIAG_TS, seq: 2,
    },
  ];
}

test("DEC-11: 事实文案键集与 DELIVERY_ERROR_CLASSES 双向对账，且全部为非空固定文案", () => {
  assert.deepEqual(
    Object.keys(DELIVERY_ERROR_CLASS_FACTS).sort(),
    [...DELIVERY_ERROR_CLASSES].sort(),
    "每个闭集成员恰有一条固定文案，无多余键",
  );
  for (const fact of Object.values(DELIVERY_ERROR_CLASS_FACTS)) {
    assert.equal(typeof fact, "string");
    assert.ok(fact.length > 0);
    assert.ok(!fact.includes(FAKE_PATH) && !fact.includes(FAKE_SECRET), "固定文案不含路径/秘密");
  }
});

test("DEC-12: 每个闭集 errorClass 都产出对应的固定文案事实", () => {
  for (const cls of DELIVERY_ERROR_CLASSES) {
    const d = diagnoseFailure(diagEvents({ errorClass: cls }), DIAG_RUN_ID);
    assert.equal(d.category, "delivery_packaging_failed", `类别 ${cls} 不改变诊断类别`);
    assert.equal(d.evidence.length, 2, `类别 ${cls} 恰追加一条事实`);
    assert.equal(d.evidence[1].eventType, "run.delivery_failed");
    assert.equal(d.evidence[1].fact, DELIVERY_ERROR_CLASS_FACTS[cls], "追加事实是闭集对应的固定文案");
  }
});

test("DEC-13: 未知/缺失 errorClass 不产出附加事实；与 workerDeclared 同在时各出各的事实", () => {
  const unknown = diagnoseFailure(diagEvents({ errorClass: "bogus_class" }), DIAG_RUN_ID);
  assert.equal(unknown.evidence.length, 1, "未知值查不到 → 无附加事实");
  const absent = diagnoseFailure(diagEvents({}), DIAG_RUN_ID);
  assert.equal(absent.evidence.length, 1, "缺失 → 无附加事实");
  const malformed = diagnoseFailure(diagEvents({ errorClass: { injected: true } }), DIAG_RUN_ID);
  assert.equal(malformed.evidence.length, 1, "非字符串值 → 无附加事实");

  const both = diagnoseFailure(
    diagEvents({ errorClass: "git_index_locked", workerDeclared: "scope_expansion_required" }),
    DIAG_RUN_ID,
  );
  assert.equal(both.evidence.length, 3);
  assert.match(both.evidence[1].fact, /stopped on purpose and reported SCOPE_EXPANSION_REQUIRED/);
  assert.equal(both.evidence[2].fact, DELIVERY_ERROR_CLASS_FACTS.git_index_locked);
  // 未绑定调用方不消费（既有 fail-closed 绑定纪律不变）
  assert.notEqual(diagnoseFailure(diagEvents({ errorClass: "git_index_locked" })).category,
    "delivery_packaging_failed");
});

test("DEC-14: runManager EBUSY 场景端到端——诊断面拿到 file_locked 固定文案", async () => {
  const fx = await makeErrorClassFixture(async () => {
    const err = new Error("EBUSY: resource busy");
    err.code = "EBUSY";
    throw err;
  });
  try {
    await fx.run.waitForCompletion({ pollInterval: 1 });
    const events = await readTranscript(fx.transcriptPath);
    const d = diagnoseFailure(events, fx.runId);
    assert.equal(d.category, "delivery_packaging_failed");
    assert.equal(d.evidence.length, 2);
    assert.equal(d.evidence[1].fact, DELIVERY_ERROR_CLASS_FACTS.file_locked);
  } finally {
    cleanupSync(fx.root);
  }
});

// 真实的 child_process 错误形状：execFileSync 产出的超时、启动失败、非零退出，
// 分类器必须分得开。
function thrownBy(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to throw");
}

test("DEC-15: execFileSync 的真实错误形状——超时、启动失败、非零退出各归其类", () => {
  const timeout = thrownBy(() => execFileSync(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
    timeout: 200, stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
  }));
  assert.equal(timeout.code, "ETIMEDOUT", "fixture: a real timeout");
  assert.match(String(timeout.syscall), /^spawn/, "fixture: the timeout carries a spawn syscall");
  assert.deepEqual(classifyDeliveryError(timeout), { errorClass: "git_timeout" });

  const missing = thrownBy(() => execFileSync("wao-no-such-binary-for-tests", [], {
    stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
  }));
  assert.equal(missing.code, "ENOENT", "fixture: a real start failure");
  assert.deepEqual(classifyDeliveryError(missing), { errorClass: "git_spawn_failed" });

  const exit3 = thrownBy(() => execFileSync(process.execPath, ["-e", "process.exit(3)"], {
    stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
  }));
  assert.equal(exit3.status, 3, "fixture: a real non-zero exit");
  assert.deepEqual(classifyDeliveryError(exit3), { errorClass: "git_command_failed", gitExitStatus: 3 });
});

test("DEC-16: errorClass 取继承属性名时不产出附加事实", () => {
  for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]) {
    const d = diagnoseFailure(diagEvents({ errorClass: name }), DIAG_RUN_ID);
    assert.equal(d.evidence.length, 1, `${name} → 无附加事实`);
    for (const ev of d.evidence) assert.equal(typeof ev.fact, "string");
  }
});
