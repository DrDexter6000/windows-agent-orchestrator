// test/backends/codexSandbox.test.js
//
// 决定 0086（codex 车道每次调用显式启用 OS 写沙箱）——确定性一翼的证伪优先测试。
//
// 覆盖面：
//   1. 参数构建：首轮与 resume 轮都带三项 -c（workspace-write / network_access /
//      approval_policy），顺序与位置固定（基础 exec 参数之后、--model 与其余 -c
//      之前、prompt 之前）；任何路径不出现 danger-full-access；readOnly 任务不
//      分支（同样 workspace-write）；preflight 与 spawn 用同一 buildArgs（一致性
//      经注入的假 spawn 实测，不靠注释）。
//   2. 源级钉：三项参数来自 CODEX_WRITE_SANDBOX_ARGS 单一常量；codex.js 源码不
//      出现 danger-full-access。
//   3. 能力面：codex 声明 enforcesWriteSandbox=true 且独有 probeWriteSandbox；
//      其余工厂 backend 一律 false 且无该方法（共享代码按声明分支，不按名字）。
//   4. probeWriteSandbox（注入假 spawnSync，不真跑 codex）：成功形状的 argv、
//      自报告标记的归类与退出码/existsSync 观察；codex 入口走车道配置；退出码
//      2 + Usage → 不可用；spawn 错误 → 不可用；codex 不可解析 → 不可用；不抛出。
//
// 真实 codex sandbox 的活体取证（消耗 codex 进程、不经模型）在 reliability 的
// sandboxEnforcement drill——实跑 `npm run reliability` 由 Owner 决定。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { CodexBackend, CODEX_WRITE_SANDBOX_ARGS, PROBE_MARKERS, probeOutcome, probeWriteCommand } from "../../src/backends/codex.js";
import { backendFor, backendCapabilitySnapshot } from "../../src/backends/factory.js";
import { sandboxEnforcementChecks } from "../../scripts/reliability/sandboxEnforcement.mjs";
import { checkStateOf } from "../../scripts/reliability/checkStates.mjs";

const SANDBOX_BLOCK = [
  "-c", 'sandbox_mode="workspace-write"',
  "-c", "sandbox_workspace_write.network_access=true",
  "-c", 'approval_policy="never"',
];

const RESUME_ROUTING = { mode: "lead_workspace", opaqueUuid: "00000000-0000-4000-8000-000000000000", turn: "resume", priorRunId: "run_20261016200000000aaaaa" };
const CODEX_THREAD = "01a0c56d-981d-7ad3-9613-0050e1546f8d";

const CODEX_SRC = readFileSync(new URL("../../src/backends/codex.js", import.meta.url), "utf8");

// ════ 1. 参数构建 ════

test("首轮 exec：三项沙箱 -c 固定插在基础参数之后、prompt 之前", () => {
  const backend = new CodexBackend();
  const args = backend.buildArgs({}, { prompt: "do the task" });
  assert.deepEqual(
    args.slice(0, 3),
    ["exec", "--json", "--skip-git-repo-check"],
    "基础 exec 参数不变（既有钉不回归）",
  );
  assert.deepEqual(
    args.slice(3, 9),
    SANDBOX_BLOCK,
    "三项沙箱参数紧跟基础参数，顺序固定",
  );
  assert.equal(args[args.length - 1], "-", "末尾提示位是 -：提示词走标准输入");
  assert.ok(!args.includes("do the task"), "提示词不进命令行");
});

test("resume 轮 exec resume：同一三项沙箱 -c，同样固定位置", () => {
  const backend = new CodexBackend();
  const args = backend.buildArgs(
    {},
    { prompt: "continue", sessionReuse: RESUME_ROUTING, priorProviderSessionId: CODEX_THREAD },
  );
  assert.deepEqual(
    args.slice(0, 5),
    ["exec", "resume", CODEX_THREAD, "--json", "--skip-git-repo-check"],
    "resume 基础参数不变",
  );
  assert.deepEqual(
    args.slice(5, 11),
    SANDBOX_BLOCK,
    "resume 轮同样带三项沙箱参数（exec resume 不接受 -s，一律 -c）",
  );
  assert.equal(args[args.length - 1], "-");
  assert.ok(!args.includes("continue"));
});

test("带 model/effort/roleContract 时：沙箱块仍在 --model 与其余 -c 之前", () => {
  const backend = new CodexBackend();
  const args = backend.buildArgs(
    { model: { id: "gpt-6.1-sol" }, reasoning: { effort: "high" } },
    { prompt: "task", roleContract: "ROLE_MARKER" },
  );
  const sandboxStart = args.indexOf('sandbox_mode="workspace-write"');
  assert.ok(sandboxStart > 0);
  assert.ok(args.indexOf("--model") > sandboxStart, "--model 在沙箱块之后");
  assert.ok(
    args.findIndex((a) => typeof a === "string" && a.includes("model_reasoning_effort")) > sandboxStart,
    "effort 的 -c 在沙箱块之后",
  );
  assert.ok(
    args.findIndex((a) => typeof a === "string" && a.includes("developer_instructions")) > sandboxStart,
    "roleContract 的 -c 在沙箱块之后",
  );
  assert.equal(args[args.length - 1], "-", "提示位仍在末尾");
});

test("readOnly 任务不分支：参数与普通任务逐字节相同（同样 workspace-write）", () => {
  const backend = new CodexBackend();
  const plain = backend.buildArgs({}, { prompt: "review only" });
  const readOnly = backend.buildArgs({}, { prompt: "review only", readOnly: true });
  assert.deepEqual(readOnly, plain, "只读运行同样使用 workspace-write，无 readOnly 参数分支");
});

test("任何构建路径都不出现 danger-full-access", () => {
  const backend = new CodexBackend();
  const paths = [
    backend.buildArgs({}, { prompt: "p" }),
    backend.buildArgs({}, { prompt: "p", sessionReuse: RESUME_ROUTING, priorProviderSessionId: CODEX_THREAD }),
    backend.buildArgs({ model: { id: "m" }, reasoning: { effort: "high" } }, { prompt: "p", roleContract: "r" }),
  ];
  for (const args of paths) {
    assert.ok(
      !args.some((a) => typeof a === "string" && a.includes("danger-full-access")),
      "argv 不得出现 danger-full-access",
    );
  }
  assert.ok(
    !CODEX_WRITE_SANDBOX_ARGS.some((a) => a.includes("danger-full-access")),
    "源常量本身不得含 danger-full-access",
  );
});

test("preflight 与 spawn 用同一 buildArgs：注入假 spawn 比对两次解析的 argv", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-cdx-sbx-pf-"));
  try {
    const agent = { id: "coder_sol", backend: "codex", cwd: dir };
    const task = { prompt: "matrix", sessionReuse: RESUME_ROUTING, priorProviderSessionId: CODEX_THREAD };
    const backend = new CodexBackend();
    // 解析确定性：固定 codex 入口，preflight（pre-worktree）与 spawn（post-worktree）
    // 必须解析出同一 { binary, args }。
    backend.resolveBinary = async () => ({ binary: process.execPath, prependArgs: ["codex.js"] });

    const preflight = await backend.preflightInvocation(agent, task);

    const spawnCalls = [];
    backend._spawnFn = (binary, args, opts) => {
      spawnCalls.push({ binary, args, opts });
      // spawn 即拒（backendCapabilityMatrix 同款）：断言面是 argv 本身。
      const child = {
        pid: 424242,
        exitCode: 1,
        signalCode: null,
        once(event, fn) {
          if (event === "error") queueMicrotask(() => fn(new Error("sandbox-test: spawn refused")));
        },
        on() {},
        kill() {},
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      return child;
    };
    await assert.rejects(() => backend.spawn(agent, task), /sandbox-test: spawn refused/);

    assert.equal(spawnCalls.length, 1);
    assert.deepEqual(
      spawnCalls[0].args,
      [...preflight.args],
      "spawn 与 preflight 的完整 argv 一致（buildArgs 确定性，沙箱参数不因路径漂移）",
    );
    assert.deepEqual(
      spawnCalls[0].args.slice(spawnCalls[0].args.indexOf("resume") + 1),
      backend.buildArgs(agent, task).slice(2),
      "spawn argv 的 buildArgs 段与直接调用逐字节一致",
    );
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// ════ 2. 源级钉 ════

test("源级钉：三项参数来自 CODEX_WRITE_SANDBOX_ARGS 单一常量，buildArgs 只经展开引用", () => {
  assert.deepEqual(CODEX_WRITE_SANDBOX_ARGS, SANDBOX_BLOCK, "常量形状冻结（六元素，顺序固定）");
  assert.ok(
    CODEX_WRITE_SANDBOX_ARGS.includes('sandbox_mode="workspace-write"'),
    "workspace-write 在场",
  );
  // 取参链：buildArgs 经 ...CODEX_WRITE_SANDBOX_ARGS 展开，不在函数体里复制第二份字面量。
  assert.ok(
    CODEX_SRC.includes("args.push(...CODEX_WRITE_SANDBOX_ARGS)"),
    "buildArgs 必须展开源常量（复制字面量会造第二份会漂的值）",
  );
  const literalOccurrences = CODEX_SRC.match(/sandbox_mode="workspace-write"/g) ?? [];
  assert.equal(
    literalOccurrences.length,
    1,
    "sandbox_mode 字面量只出现在常量定义处（单一真相源）",
  );
  assert.ok(
    !CODEX_SRC.includes("danger-full-access"),
    "codex 后端源码任何位置不得出现 danger-full-access",
  );
});

// ════ 3. 能力面（声明闭集）════

test("能力面：codex 声明 enforcesWriteSandbox=true 且独有 probeWriteSandbox；其余工厂 backend 一律 false 且无该方法", () => {
  const codex = backendFor({ backend: "codex" });
  assert.equal(codex.enforcesWriteSandbox, true);
  assert.equal(typeof codex.probeWriteSandbox, "function", "声明能力的后端提供探测方法");
  assert.equal(backendCapabilitySnapshot({ backend: "codex" }).enforcesWriteSandbox, true);

  const others = [
    "opencode-serve",
    "claude-code",
    "kimi-code",
    "deepseek-harness",
    "deepseek-acp",
    "kimi-web",
    "zcode",
  ];
  for (const name of others) {
    const backend = backendFor(
      name === "opencode-serve"
        ? { backend: name, serveUrl: "http://127.0.0.1:4299", agent: "build", cwd: "D:/x", model: { providerID: "p", id: "m" } }
        : name === "kimi-web"
          ? { backend: name, serveUrl: "http://127.0.0.1:4310", cwd: "D:/x", model: { id: "kimi-code/k3" }, tokenEnv: "T" }
          : { backend: name, cwd: "D:/x" },
    );
    assert.equal(backend.enforcesWriteSandbox, false, `${name} 如实声明无 OS 写沙箱`);
    assert.equal(
      typeof backend.probeWriteSandbox,
      "undefined",
      `${name} 不提供探测方法（共享代码按声明分支，不按名字猜）`,
    );
    assert.equal(backendCapabilitySnapshot({ backend: name }).enforcesWriteSandbox, false);
  }
});

// ════ 4. probeWriteSandbox（注入假 spawnSync）════

function makeProbeBackend({ spawnSyncImpl, binary = "node", prependArgs = ["codex.js"] } = {}) {
  const backend = new CodexBackend({ sandboxProbeSpawnSync: spawnSyncImpl });
  backend.resolveBinary = async () => ({ binary, prependArgs });
  return backend;
}

test("probe：树内/树外各探测一次——argv 形状、自报告标记、退出码与 existsSync 观察", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-cdx-sbx-probe-"));
  try {
    const insidePath = join(dir, "inside.txt");
    const outsidePath = join(dir, "outside.txt");
    const calls = [];
    const backend = makeProbeBackend({
      // 假沙箱：树内写落盘、打印写成标记并退出 0；树外写被访问控制拒绝（打印
      // 被拒标记、退出 3、不落盘）。
      spawnSyncImpl: (binary, args, opts) => {
        calls.push({ binary, args, opts });
        const command = args[args.length - 1];
        if (command.includes(insidePath)) {
          writeFileSync(insidePath, "probe", "utf8");
          return { status: 0, stdout: `${PROBE_MARKERS.written}\n`, stderr: "" };
        }
        return { status: 3, stdout: `${PROBE_MARKERS.denied}\n`, stderr: "" };
      },
    });
    const result = await backend.probeWriteSandbox({ cwd: dir, insidePath, outsidePath });

    assert.equal(result.available, true);
    assert.deepEqual(result.inside, { exitCode: 0, fileExists: true, outcome: "written", output: PROBE_MARKERS.written });
    assert.equal(result.outside.exitCode, 3);
    assert.equal(result.outside.fileExists, false);
    assert.equal(result.outside.outcome, "denied");

    assert.equal(calls.length, 2, "恰好两次探测（树内、树外各一次）");
    for (const call of calls) {
      assert.equal(call.binary, "node");
      const args = call.args;
      assert.equal(args[0], "codex.js", "codex 入口经 resolveBinary 的 prependArgs");
      assert.deepEqual(
        args.slice(1, 6),
        ["sandbox", "-P", ":workspace", "-C", dir],
        "codex sandbox 子命令：workspace profile、沙箱根 = 运行 cwd（-C，Node spawn 无 MSYS 改写）",
      );
      assert.equal(args[6], "--");
      const shellIdx = 7;
      assert.equal(args[shellIdx + 1], "-NoProfile");
      assert.equal(args[shellIdx + 2], "-Command");
      const command = args[shellIdx + 3];
      assert.match(command, /Set-Content -LiteralPath '/, "固定写命令经 PowerShell 绝对路径执行");
      assert.match(command, /catch \[System\.UnauthorizedAccessException\]/, "被访问控制拒绝单独归类");
      for (const marker of Object.values(PROBE_MARKERS)) {
        assert.ok(!command.includes(marker), `命令原文不得出现完整标记 ${marker}（运行时拼出，回显不会被当成报告）`);
      }
      assert.ok(
        command.includes(insidePath) || command.includes(outsidePath),
        "命令携带探测目标路径",
      );
      assert.ok(
        !args.some((a) => typeof a === "string" && a.includes("danger-full-access")),
        "探测 argv 同样不出现 danger-full-access",
      );
      assert.ok(Number.isFinite(call.opts.timeout) && call.opts.timeout > 0, "探测带超时预算");
    }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test("probe【分类】：退出码 2 且打印 Usage → 不可用（不抛出，树外不再探测）", async () => {
  const calls = [];
  const backend = makeProbeBackend({
    spawnSyncImpl: () => {
      calls.push(1);
      return { status: 2, stdout: "error: unexpected argument\nUsage: codex sandbox …", stderr: "" };
    },
  });
  const result = await backend.probeWriteSandbox({
    cwd: "D:/tmp/repo",
    insidePath: "D:/tmp/repo/in.txt",
    outsidePath: "D:/elsewhere/out.txt",
  });
  assert.equal(result.available, false);
  assert.match(result.reason, /usage/i, "不可用原因写明 Usage 拒绝形态");
  assert.equal(calls.length, 1, "首个探测即被拒——外部探测不再发起");
});

test("probe【分类】：退出码 2 但无 Usage 字样 → 不判为不可用，照常返回退出码，outcome 为 not_run", async () => {
  const backend = makeProbeBackend({
    spawnSyncImpl: () => ({ status: 2, stdout: "", stderr: "some other failure" }),
  });
  const result = await backend.probeWriteSandbox({
    cwd: "D:/tmp/repo",
    insidePath: "D:/tmp/repo/in.txt",
    outsidePath: "D:/elsewhere/out.txt",
  });
  assert.equal(result.available, true, "退出码 2 不必然是 Usage 拒绝——结果交判定内核");
  assert.equal(result.inside.exitCode, 2);
  assert.equal(result.outside.exitCode, 2);
  assert.equal(result.outside.outcome, "not_run", "没有任何自报告标记 = 命令没在沙箱里跑起来");
});

test("probe：codex 入口走车道配置（binary/prependArgs），与真实派发同一解析链", async () => {
  const calls = [];
  const backend = new CodexBackend({
    sandboxProbeSpawnSync: (binary, args) => {
      calls.push({ binary, args });
      return { status: 3, stdout: PROBE_MARKERS.denied, stderr: "" };
    },
  });
  backend.resolveBinary = async () => {
    throw new Error("默认解析不应被调用：车道配置了 binary");
  };
  const result = await backend.probeWriteSandbox({
    agent: { binary: "C:/custom/codex-lane.exe", prependArgs: ["--lane-flag"] },
    cwd: "D:/tmp/repo",
    insidePath: "D:/tmp/repo/in.txt",
    outsidePath: "D:/elsewhere/out.txt",
  });
  assert.equal(result.available, true);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.binary, "C:/custom/codex-lane.exe", "探测的 codex 就是车道派发的那个");
    assert.equal(call.args[0], "--lane-flag", "车道配置的 prependArgs 在 sandbox 子命令之前");
    assert.equal(call.args[1], "sandbox");
  }
});

test("probeOutcome / probeWriteCommand：标记归类与写命令形状", () => {
  assert.equal(probeOutcome(`x\n${PROBE_MARKERS.written}\n`), "written");
  assert.equal(probeOutcome(PROBE_MARKERS.denied), "denied");
  assert.equal(probeOutcome(`${PROBE_MARKERS.error} System.IO.DirectoryNotFoundException`), "error");
  assert.equal(probeOutcome("windows sandbox failed: runner failed during SpawnChild"), "not_run");
  assert.equal(probeOutcome(""), "not_run");
  assert.equal(probeOutcome(`${PROBE_MARKERS.written}\n${PROBE_MARKERS.denied}`), "not_run", "两种标记同时出现是矛盾");
  assert.equal(probeOutcome(`prefix ${PROBE_MARKERS.denied} suffix`), "not_run", "嵌在长行里的标记不算报告");
  const command = probeWriteCommand("D:/x/out.txt", "S1");
  assert.match(command, /-ErrorAction Stop/, "写失败必须进 catch，不能静默继续");
  assert.match(command, /exit 0 \}/);
  assert.match(command, /exit 3 \}/);
  assert.match(command, /exit 4 \}/);
});

test("probe【证伪】：沙箱启动失败并回显整条命令 → outcome not_run，判定内核记 inconclusive", async () => {
  const backend = makeProbeBackend({
    spawnSyncImpl: (binary, args) => {
      const command = args[args.length - 1];
      // 树内照常写成；树外：沙箱里的子进程起不来，错误信息回显整条命令
      if (command.includes("in.txt")) return { status: 0, stdout: `${PROBE_MARKERS.written}\n`, stderr: "" };
      return { status: 1, stdout: "", stderr: `windows sandbox failed: runner failed during SpawnChild: CreateProcessAsUserW failed: 2 | cmd=${args.join(" ")}` };
    },
  });
  const result = await backend.probeWriteSandbox({
    cwd: "D:/tmp/repo", insidePath: "D:/tmp/repo/in.txt", outsidePath: "D:/elsewhere/out.txt",
  });
  assert.equal(result.outside.outcome, "not_run", "回显的命令原文不得被归成被拒");
  const outsideCheck = sandboxEnforcementChecks({ probeResult: result }).find((c) => c.name === "sandboxOutsideWriteDenied");
  assert.equal(checkStateOf(outsideCheck), "inconclusive");
});

test("probe【分类】：spawn 错误（进程没跑起来）/ 超时无退出码 / codex 不可解析 → 不可用", async () => {
  const spawnFailed = makeProbeBackend({
    spawnSyncImpl: () => ({ error: new Error("spawn ENOENT"), status: null, stdout: "", stderr: "" }),
  });
  const r1 = await spawnFailed.probeWriteSandbox({
    cwd: "D:/tmp/repo", insidePath: "D:/tmp/repo/in.txt", outsidePath: "D:/elsewhere/out.txt",
  });
  assert.equal(r1.available, false);
  assert.match(r1.reason, /did not run/);

  const timedOut = makeProbeBackend({
    spawnSyncImpl: () => ({ status: null, stdout: "", stderr: "" }),
  });
  const r2 = await timedOut.probeWriteSandbox({
    cwd: "D:/tmp/repo", insidePath: "D:/tmp/repo/in.txt", outsidePath: "D:/elsewhere/out.txt",
  });
  assert.equal(r2.available, true, "超时形状照常返回——exitCode:null 由判定内核按不确定处理");
  assert.equal(r2.inside.exitCode, null);
  assert.equal(r2.outside.exitCode, null);

  const unresolvable = new CodexBackend();
  unresolvable.resolveBinary = async () => {
    throw new Error("agent codex-probe missing binary for process backend");
  };
  const r3 = await unresolvable.probeWriteSandbox({
    cwd: "D:/tmp/repo", insidePath: "D:/tmp/repo/in.txt", outsidePath: "D:/elsewhere/out.txt",
  });
  assert.equal(r3.available, false);
  assert.match(r3.reason, /not resolvable/);
});

test("probe：缺参不抛出——不可用形状", async () => {
  const backend = makeProbeBackend({ spawnSyncImpl: () => ({ status: 0, stdout: "", stderr: "" }) });
  const result = await backend.probeWriteSandbox({});
  assert.equal(result.available, false);
  assert.match(result.reason, /requires/);
});
