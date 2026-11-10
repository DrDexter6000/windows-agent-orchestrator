// test/backends/processJob.test.js
//
// 只观测作业对象（决定 0121）的确定性单测：零真实 PowerShell、零真实进程。
// 哨兵解析、attach 结果闭集与失败码、脚本文本红线（绝不出现
// SetInformationJobObject / breakaway 常量——见 src/backends/processJob.js 文件
// 头的边界），以及 snapshotRunProcesses 的 job 行解析与 describeProcessJobActivity
// 的作业证词判定（真进程形状由 test/backends/processJobMsys.test.js 钉）。
import { test } from "node:test";
import assert from "node:assert/strict";

import { attachProcessJob, parseAttachSentinel } from "../../src/backends/processJob.js";
import {
  describeProcessJobActivity,
  parseJobSnapshotLine,
  snapshotRunProcesses,
  PROCESS_ACTIVE_CPU_MS_PER_S,
  PROCESS_ACTIVE_IO_BYTES_PER_S,
} from "../../src/backends/processActivity.js";

// ===== 哨兵解析（纯函数） =====

test("parseAttachSentinel: 成功行取名字；四步失败行取步骤 + Win32 错误号", () => {
  const name = "Local\\wao-job-4242-0123456789abcdef0123456789abcdef";
  assert.deepEqual(parseAttachSentinel(`noise\r\nwao-job:ok:${name}\r\n`), { ok: true, name });
  for (const step of ["create", "open_process", "assign", "duplicate"]) {
    assert.deepEqual(
      parseAttachSentinel(`wao-job:fail:${step}:5`),
      { ok: false, code: step, win32: 5 },
      `步骤 ${step} 的失败行`,
    );
  }
  assert.deepEqual(parseAttachSentinel("wao-job:fail:open_process:87\n"), { ok: false, code: "open_process", win32: 87 });
});

test("parseAttachSentinel: 无哨兵 / 形状不合法 → no_sentinel（win32: null）", () => {
  assert.deepEqual(parseAttachSentinel(""), { ok: false, code: "no_sentinel", win32: null });
  assert.deepEqual(parseAttachSentinel("Add-Type ok\r\nnothing else"), { ok: false, code: "no_sentinel", win32: null });
  assert.deepEqual(parseAttachSentinel(null), { ok: false, code: "no_sentinel", win32: null });
  // ok 行宽容回显（空名字也原样返回）；可信度由 attachProcessJob 的名字核对把关
  assert.deepEqual(parseAttachSentinel("wao-job:ok:"), { ok: true, name: "" });
  // 失败行：未知步骤 / 非数字错误号 / 段数不对
  assert.deepEqual(parseAttachSentinel("wao-job:fail:terminate:5"), { ok: false, code: "no_sentinel", win32: null });
  assert.deepEqual(parseAttachSentinel("wao-job:fail:create:oops"), { ok: false, code: "no_sentinel", win32: null });
  assert.deepEqual(parseAttachSentinel("wao-job:fail:create:5:6"), { ok: false, code: "no_sentinel", win32: null });
  // 未知前缀形状
  assert.deepEqual(parseAttachSentinel("wao-job:weird"), { ok: false, code: "no_sentinel", win32: null });
});

// ===== attachProcessJob：不适用 / 失败码闭集 / 脚本红线 =====

test("attachProcessJob: 非 Windows / 非法 pid → null（不适用），不碰执行器", async () => {
  let called = 0;
  const run = async () => { called += 1; return "wao-job:ok:x"; };
  assert.equal(await attachProcessJob(100, { run, platform: "linux" }), null);
  assert.equal(await attachProcessJob(0, { run, platform: "win32" }), null);
  assert.equal(await attachProcessJob(undefined, { run, platform: "win32" }), null);
  assert.equal(await attachProcessJob(-1, { run, platform: "win32" }), null);
  assert.equal(called, 0);
});

test("attachProcessJob: 成功 → {ok, name}，名字形状 Local\\wao-job-<pid>-<128 位十六进制>", async () => {
  // 名字由调用侧随机生成——对端必须回显脚本里的那个名字（固定回显必被核对拒绝，
  // 见"哨兵名字对不上"用例）。
  let echo = "";
  const res = await attachProcessJob(4242, {
    run: async (script) => {
      echo = script.match(/Local\\wao-job-4242-[0-9a-f]{32}/)[0];
      return `wao-job:ok:${echo}`;
    },
  });
  assert.deepEqual(res, { ok: true, name: echo });
});

test("attachProcessJob: 脚本红线——不含 SetInformationJobObject、不含任何 breakaway 常量；四个 P/Invoke 齐备；名字嵌进脚本", async () => {
  let script = "";
  const res = await attachProcessJob(777, {
    run: async (text) => {
      script = text;
      const match = text.match(/Local\\wao-job-777-[0-9a-f]{32}/);
      assert.ok(match, "生成的名字嵌入脚本");
      return `wao-job:ok:${match[0]}`;
    },
  });
  assert.equal(res.ok, true);
  assert.match(res.name, /^Local\\wao-job-777-[0-9a-f]{32}$/);
  // 只观测三红线：绝不配置作业（kill-on-close / breakaway / silent breakaway 都经
  // SetInformationJobObject），也不引用任何脱离标志常量。
  assert.ok(!script.includes("SetInformationJobObject"), "绝不调用 SetInformationJobObject");
  assert.ok(!/BREAKAWAY/i.test(script), "不含任何 breakaway 字样/常量");
  assert.ok(!script.includes("TerminateJobObject"), "不调用 TerminateJobObject");
  for (const api of ["CreateJobObjectW", "OpenProcess", "AssignProcessToJobObject", "DuplicateHandle", "CloseHandle"]) {
    assert.ok(script.includes(api), `${api} 在脚本里`);
  }
  assert.match(script, /0x141|321/, "OpenProcess 访问权 = TERMINATE|DUP_HANDLE|SET_QUOTA");
});

test("attachProcessJob: PowerShell 起不来 / 超时 → spawn_failed / timeout；哨兵名字对不上 → no_sentinel", async () => {
  assert.deepEqual(
    await attachProcessJob(100, { run: async () => { throw new Error("spawn ENOENT"); } }),
    { ok: false, code: "spawn_failed", win32: null },
  );
  assert.deepEqual(
    await attachProcessJob(100, { run: async () => { throw Object.assign(new Error("killed"), { timedOut: true }); } }),
    { ok: false, code: "timeout", win32: null },
  );
  assert.deepEqual(
    await attachProcessJob(100, { run: async () => "wao-job:ok:Local\\wao-job-9999-0123456789abcdef0123456789abcdef" }),
    { ok: false, code: "no_sentinel", win32: null },
    "回显的名字不是本次请求的名字（请求名含 pid 100）——不可信",
  );
  assert.deepEqual(
    await attachProcessJob(100, { run: async () => "" }),
    { ok: false, code: "no_sentinel", win32: null },
  );
});

// ===== snapshotRunProcesses：job 行解析与合并快照 =====

const TABLE_TEXT = [
  "100,4,50000000,1000",  // 宿主
  "200,100,10000000,500", // 子
  "300,200,20000000,700", // 孙
  "400,4,90000000,9999",  // 无关进程
  "500,500,1,1",          // 自指——不得进入遍历
  "garbage line",
  "",
].join("\r\n");

test("snapshotRunProcesses: 不适用 → null；无 jobName → 只取进程表（job: null, jobNote: null）", async () => {
  let calls = 0;
  const run = async (cmd) => { calls += 1; return TABLE_TEXT; };
  assert.equal(await snapshotRunProcesses(100, { run, platform: "linux" }), null);
  assert.equal(await snapshotRunProcesses(0, { run, platform: "win32" }), null);
  assert.equal(calls, 0);
  const snap = await snapshotRunProcesses(100, { run, platform: "win32" });
  assert.deepEqual([...snap.tree.keys()].sort(), [200, 300]);
  assert.deepEqual(snap.host, { cpu100ns: 50000000, ioBytes: 1000 });
  assert.equal(snap.job, null);
  assert.equal(snap.jobNote, null);
});

test("snapshotRunProcesses: jobName → 同一次命令里带作业查询，job 行解析成读数且不污染进程表", async () => {
  let command = "";
  const run = async (cmd) => {
    command = cmd;
    return `${TABLE_TEXT}\r\njob,1234500,678900,7,3`;
  };
  const snap = await snapshotRunProcesses(100, { jobName: "Local\\wao-job-100-0123456789abcdef0123456789abcdef", run, platform: "win32" });
  assert.ok(command.includes("Local\\wao-job-100-0123456789abcdef0123456789abcdef"), "作业名嵌进取样命令");
  assert.deepEqual([...snap.tree.keys()].sort(), [200, 300], "job 行不进进程表");
  assert.deepEqual(snap.host, { cpu100ns: 50000000, ioBytes: 1000 });
  assert.deepEqual(snap.job, { cpu100ns: 1234500, ioBytes: 678900, totalProcesses: 7, activeProcesses: 3 });
  assert.equal(snap.jobNote, null);
});

const WELL_FORMED_JOB_NAME = "Local\\wao-job-100-0123456789abcdef0123456789abcdef";

test("snapshotRunProcesses: job,unavailable / 坏行 / 缺行 → job: null + 原因；宿主不在表里照旧抛错", async () => {
  const withJob = (jobLine) => snapshotRunProcesses(100, {
    jobName: WELL_FORMED_JOB_NAME,
    run: async () => `${TABLE_TEXT}\r\n${jobLine}`,
    platform: "win32",
  });
  const unavailable = await withJob("job,unavailable,2");
  assert.equal(unavailable.job, null);
  assert.equal(unavailable.jobNote, "job query unavailable (win32 error 2)");
  assert.deepEqual(unavailable.tree.get(200), { cpu100ns: 10000000, ioBytes: 500 }, "走树读数不受影响");
  for (const [label, line] of [["坏行（段数）", "job,1,2,3,4,5"], ["坏行（负数）", "job,-1,2,3,4"], ["坏行（非数字）", "job,x,2,3,4"], ["非 unavailable 三段", "job,pending,5"]]) {
    const bad = await withJob(line);
    assert.equal(bad.job, null, `${label} → job null`);
    assert.equal(bad.jobNote, "malformed job line", `${label} → 原因写明`);
  }
  const missing = await snapshotRunProcesses(100, {
    jobName: WELL_FORMED_JOB_NAME,
    run: async () => TABLE_TEXT,
    platform: "win32",
  });
  assert.deepEqual([missing.job, missing.jobNote], [null, "job line missing"]);
  await assert.rejects(
    () => snapshotRunProcesses(777, { jobName: "Local\\wao-job-777-0123456789abcdef0123456789abcdef", run: async () => TABLE_TEXT, platform: "win32" }),
    /host process not found/,
  );
  await assert.rejects(
    () => snapshotRunProcesses(100, { jobName: WELL_FORMED_JOB_NAME, run: async () => { throw new Error("boom"); }, platform: "win32" }),
    /boom/,
  );
});

test("parseJobSnapshotLine: 直测三形（正常 / unavailable / 坏）", () => {
  assert.deepEqual(
    parseJobSnapshotLine("job,1,2,3,4"),
    { job: { cpu100ns: 1, ioBytes: 2, totalProcesses: 3, activeProcesses: 4 }, jobNote: null },
  );
  assert.deepEqual(parseJobSnapshotLine("  job,unavailable,5\r\n"), { job: null, jobNote: "job query unavailable (win32 error 5)" });
  assert.deepEqual(parseJobSnapshotLine("job,1,2"), { job: null, jobNote: "malformed job line" });
  assert.deepEqual(parseJobSnapshotLine(""), { job: null, jobNote: "job line missing" });
});

// ===== 取样命令红线（第 94 批续修：类号/长度/偏移按本机实测钉死，防凭记忆改回 9/104） =====

test("snapshotRunProcesses 命令文本：查询类 8、缓冲 96、偏移 0/8/36/40/72/80/88；作业段包 try/catch（固定码 13）", async () => {
  let command = "";
  const run = async (cmd) => {
    command = cmd;
    return `${TABLE_TEXT}\r\njob,1,2,3,4`;
  };
  await snapshotRunProcesses(100, { jobName: "Local\\wao-job-100-0123456789abcdef0123456789abcdef", run, platform: "win32" });
  // 查询类与缓冲长度（2026-11-09 本机实测：类 8 恰收 96 字节；9 号是另一个结构）
  assert.match(command, /QueryInformationJobObject\(\$job, 8, \$buf, 96, \[IntPtr\]::Zero\)/, "类号 8、长度 96");
  assert.match(command, /New-Object byte\[\] 96/, "缓冲 96 字节");
  // 结构体偏移：CPU 两项 @0/@8，TotalProcesses@36、ActiveProcesses@40，TransferCount@72/80/88
  for (const offset of [0, 8, 72, 80, 88]) {
    assert.match(command, new RegExp(`ToUInt64\\(\\$buf, ${offset}\\)`), `u64 偏移 ${offset} 在场`);
  }
  for (const offset of [36, 40]) {
    assert.match(command, new RegExp(`ToUInt32\\(\\$buf, ${offset}\\)`), `u32 偏移 ${offset} 在场`);
  }
  // 两段互不拖累：作业段（Add-Type 起）整体包 try/catch，硬失败落固定码 13
  // （ERROR_INVALID_DATA 形状）——进程表行照常输出、命令照常成功退出。
  assert.match(command, /try \{\s*Add-Type -TypeDefinition/, "作业段从 Add-Type 起包进 try");
  assert.match(command, /catch \{\s*'job,unavailable,13'/, "catch 落固定码 13");
});

test("snapshotRunProcesses: 作业段 catch 落的固定码行被当 unavailable 解析，进程表行照常进 tree", async () => {
  const snap = await snapshotRunProcesses(100, {
    jobName: "Local\\wao-job-100-0123456789abcdef0123456789abcdef",
    run: async () => `${TABLE_TEXT}\r\njob,unavailable,13`,
    platform: "win32",
  });
  assert.deepEqual([...snap.tree.keys()].sort(), [200, 300], "进程表行不受作业段失败拖累");
  assert.equal(snap.job, null);
  assert.equal(snap.jobNote, "job query unavailable (win32 error 13)");
});

test("snapshotRunProcesses: jobName 不符生成格式 → 不嵌进命令、不查作业，按不可用处理；空串同缺席", async () => {
  for (const bad of ["not-a-job", "Local\\wao-job-100-short", "Local\\wao-job-100-0123456789ABCDEF0123456789ABCDEF", "Local\\wao-job-100-0123456789abcdef0123456789abcde'; Write-Output boom"]) {
    let command = "";
    const snap = await snapshotRunProcesses(100, {
      jobName: bad,
      run: async (cmd) => { command = cmd; return TABLE_TEXT; },
      platform: "win32",
    });
    assert.ok(!command.includes(bad), `非法名不得嵌进命令（${bad.slice(0, 24)}…）`);
    assert.ok(!command.includes("OpenJobObjectW"), "不查作业");
    assert.equal(snap.job, null, "按不可用处理");
    assert.equal(snap.jobNote, "invalid job name");
    assert.deepEqual([...snap.tree.keys()].sort(), [200, 300], "进程表照常");
  }
  // 空串 = 缺席形状（没这项证词），不是"非法名"。
  let command = "";
  const empty = await snapshotRunProcesses(100, {
    jobName: "",
    run: async (cmd) => { command = cmd; return TABLE_TEXT; },
    platform: "win32",
  });
  assert.ok(!command.includes("OpenJobObjectW"));
  assert.deepEqual([empty.job, empty.jobNote], [null, null]);
});

// ===== describeProcessJobActivity：作业证词判定（决定 0121） =====

const hostRow = (cpuMs, io) => ({ cpu100ns: cpuMs * 10_000, ioBytes: io });
const jobRow = (cpuMs, io, total, active) => ({ cpu100ns: cpuMs * 10_000, ioBytes: io, totalProcesses: total, activeProcesses: active });

test("describeProcessJobActivity: 静止不算活动；作业 CPU/IO（扣宿主后）越线即算", () => {
  const before = { host: hostRow(1000, 100_000), job: jobRow(1200, 150_000, 5, 5) };
  // 宿主涨 50ms / 100KB，作业累计涨 75ms / 126KB → 净 +25ms CPU / +26KB io（30s，
  // 均低于阈值——空闲后代读数的数量级）。
  const idle = describeProcessJobActivity(before, { host: hostRow(1050, 200_000), job: jobRow(1275, 276_000, 5, 5) }, 30_000);
  assert.equal(idle.available, true);
  assert.equal(idle.active, false, "扣掉宿主后 +25ms CPU / +26KB io / 30s —— 低于阈值");
  assert.deepEqual(
    [idle.cpuMs, idle.ioBytes, idle.born, idle.activeChanged, idle.totalProcesses],
    [25, 26_000, 0, false, [5, 5]],
  );

  const cpuBusy = describeProcessJobActivity(
    before,
    { host: hostRow(1000, 100_000), job: jobRow(1200 + PROCESS_ACTIVE_CPU_MS_PER_S * 30, 150_000, 5, 5) },
    30_000,
  );
  assert.equal(cpuBusy.active, true, "作业 CPU 增量（宿主零涨）恰到阈值即算");

  const ioBusy = describeProcessJobActivity(
    before,
    { host: hostRow(1000, 100_000), job: jobRow(1200, 150_000 + PROCESS_ACTIVE_IO_BYTES_PER_S * 30, 5, 5) },
    30_000,
  );
  assert.equal(ioBusy.active, true, "作业 I/O 增量恰到阈值即算");
});

test("describeProcessJobActivity: 只有宿主自身 CPU/IO 在涨 → 不算活动；作业增量小于宿主增量钳为 0", () => {
  const before = { host: hostRow(1000, 100_000), job: jobRow(1500, 200_000, 5, 5) };
  // 宿主自身涨 5000ms CPU / 1MB io，作业累计只涨同一份（单成员作业的形状）——净 0。
  const selfOnly = describeProcessJobActivity(
    before,
    { host: hostRow(6000, 1_100_000), job: jobRow(6500, 1_200_000, 5, 5) },
    30_000,
  );
  assert.equal(selfOnly.available, true);
  assert.equal(selfOnly.active, false, "控制面每拍轮询宿主自身，其计数不能作证");
  assert.deepEqual([selfOnly.cpuMs, selfOnly.ioBytes], [0, 0]);
  // 防御形状：作业增量 < 宿主增量（不可信读数）→ 钳 0，不当活动也不抛。
  const clamped = describeProcessJobActivity(
    before,
    { host: hostRow(10_000, 5_000_000), job: jobRow(1600, 250_000, 5, 5) },
    30_000,
  );
  assert.deepEqual([clamped.available, clamped.active, clamped.cpuMs, clamped.ioBytes], [true, false, 0, 0]);
});

test("describeProcessJobActivity: 窗内进程生又灭（ActiveProcesses 不变、TotalProcesses 涨）→ 有活动；ActiveProcesses 变化（任一方向）→ 有活动", () => {
  const before = { host: hostRow(1000, 100_000), job: jobRow(1200, 150_000, 5, 5) };
  const bornAndDied = describeProcessJobActivity(
    before,
    { host: hostRow(1000, 100_000), job: jobRow(1200, 150_000, 7, 5) },
    30_000,
  );
  assert.deepEqual([bornAndDied.active, bornAndDied.born, bornAndDied.activeChanged], [true, 2, false],
    "TotalProcesses 是累计值——只活几毫秒的进程也计入");
  for (const activeAfter of [6, 4]) {
    const changed = describeProcessJobActivity(
      before,
      { host: hostRow(1000, 100_000), job: jobRow(1200, 150_000, 5, activeAfter) },
      30_000,
    );
    assert.equal(changed.active, true, `ActiveProcesses 5->${activeAfter} 是变化，即活动`);
  }
});

test("describeProcessJobActivity: 累计回退（CPU/IO/TotalProcesses 任一变小）→ 证词不可用（不当无活动）", () => {
  const before = { host: hostRow(1000, 100_000), job: jobRow(1200, 150_000, 5, 5) };
  for (const [label, after] of [
    ["CPU 回退", { host: hostRow(1000, 100_000), job: jobRow(1199, 150_000, 5, 5) }],
    ["I/O 回退", { host: hostRow(1000, 100_000), job: jobRow(1300, 149_999, 5, 5) }],
    ["TotalProcesses 回退", { host: hostRow(1000, 100_000), job: jobRow(1300, 160_000, 4, 5) }],
  ]) {
    const verdict = describeProcessJobActivity(before, after, 30_000);
    assert.deepEqual(verdict, { available: false, note: "counters regressed" }, label);
  }
});

test("describeProcessJobActivity: 任一侧 job 缺席（含 job,unavailable 原因）或宿主行缺失 → 不可用", () => {
  const before = { host: hostRow(1000, 100_000), job: jobRow(1200, 150_000, 5, 5), jobNote: null };
  assert.deepEqual(
    describeProcessJobActivity(before, { host: hostRow(1000, 100_000), job: null, jobNote: "job query unavailable (win32 error 2)" }, 30_000),
    { available: false, note: "job query unavailable (win32 error 2)" },
    "窗尾读不到 → 用窗尾的原因",
  );
  assert.deepEqual(
    describeProcessJobActivity({ host: hostRow(1, 1), job: null, jobNote: "job query unavailable (win32 error 2)" }, before, 30_000),
    { available: false, note: "job query unavailable (win32 error 2)" },
    "窗首读不到 → 用窗首的原因",
  );
  // 双侧 job 齐但一侧宿主行缺失 → host row missing；job 缺席优先于宿主行缺失。
  assert.deepEqual(
    describeProcessJobActivity({ host: null, job: jobRow(1, 1, 1, 1), jobNote: null }, { host: hostRow(1, 1), job: jobRow(2, 2, 1, 1), jobNote: null }, 30_000),
    { available: false, note: "host row missing" },
  );
  assert.deepEqual(
    describeProcessJobActivity({ host: hostRow(1, 1), job: null, jobNote: null }, { host: null, job: jobRow(2, 2, 1, 1), jobNote: null }, 30_000),
    { available: false, note: "job query unavailable" },
    "job 缺席的兜底原因（两侧都没有 jobNote 时）",
  );
});
