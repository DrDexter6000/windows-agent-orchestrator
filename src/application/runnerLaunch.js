// src/application/runnerLaunch.js
//
// TD-347（第 93 批）：后台 runner 的唯一启动口（三处调用方共用）：
//   - src/application/runDispatch.js（派发）
//   - src/application/runContinue.js（续接）
//   - src/commands/lifecycle.js forkResumeRunner（resume 接管）
//
// 两条路径：
//   - WMI 路径（Windows 缺省）：控制面经 powershell → Invoke-CimMethod
//     Win32_Process.Create 只起短命桥 src/runnerBroker.js（父进程 WmiPrvSE.exe，
//     不在宿主的 KILL_ON_JOB_CLOSE 作业里）；runner 的 execPath/argv/env/cwd/
//     prompt/stderrPath 经命名管道一帧载荷交给桥，桥 detached spawn runner 后
//     回帧 {runnerPid, handoff} 即退。宿主重启 MCP 服务不再连坐 runner。
//   - spawn 路径：本进程直接 detached spawn（原三处写法收进一处）。走它的情形：
//     非 Windows；WAO_RUNNER_LAUNCH=spawn（显式关闭开关）；调用方注入 spawnFn
//     （现有测试注入缝，保持不变）。
//
// 启动失败的收口语义（不得有第二个 runner）：
//   - WMI 建不了进程（ReturnValue≠0 / PowerShell 起不来 / 创建前失败）→
//     start_failed(wmi_create_failed)，确定没起来，不自动退回 spawn；
//   - 期限内桥没连上管道 → 关闭管道（迟到的桥拿不到载荷自己退出）→
//     start_failed(bridge_timeout)；
//   - 载荷已发出、回帧没收到 / 回帧坏 / handoff=timeout → runner 可能已在：
//     按 runnerPid / 桥 pid taskkill /T /F，再按命令行带 --run-id <runId> 且
//     创建时间不早于本次启动的 node 进程扫描兜底（取法照 runSettle 的
//     defaultRunnerScan），确认结束后才 start_failed。
//   - spawn 路径：spawn 抛错 → start_failed(spawn_error)（detail 带原始错误，
//     调用方照旧抛原错误）；提示词交接超时 → 结束 runner → start_failed
//     (prompt_handoff_timeout)。
// 结果是结构化 {outcome, runnerPid, reason}，不伪装成 ChildProcess；调用方拿到
// started 后的行为与原先一致（dispatch/continue 照常返回，resume 照常）。
//
// Architectural contract:
//   - No argv parsing, no console.log, no process.exit.
//   - Does not import src/commands/*, src/mcp/*, MCP SDK, or zod.
//   - 依赖：node 内置 + runnerPrompt.js（shared）+ runnerFrame.js（同层叶子，
//     管道帧协议）+ ownerLiveness.js（shared，pid 判活）+ delivery.js（core 下向，
//     runId 闭字母表——嵌入 PowerShell -like 模式前的防线）。

import { spawn as nodeSpawn, spawnSync, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { createServer } from "node:net";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { PROMPT_HANDOFF_TIMEOUT_MS, PROMPT_HANDOFF_TIMEOUT_TEXT, writeRunnerPrompt } from "../runnerPrompt.js";
import { isValidRunId } from "../delivery.js";
import { FrameDecoder, FrameTooLargeError, encodeFrame, validateBrokerReply } from "./runnerFrame.js";
import { isPidAlive } from "./ownerLiveness.js";

/** 桥入口（与 backgroundRunner.js 同层的 adapters 入口脚本）。 */
export const DEFAULT_BROKER_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "runnerBroker.js",
);

/** 关闭开关的环境变量名（"spawn" = 显式改回本进程直起）。 */
export const RUNNER_LAUNCH_SPAWN_ENV = "WAO_RUNNER_LAUNCH";

/** 结果闭集。 */
export const RUNNER_LAUNCH_OUTCOMES = Object.freeze(["started", "start_failed"]);

/**
 * 启动失败原因闭集（各调用方按现有启动失败收口处理；文本见
 * runnerLaunchFailureText）。payload_too_large / pipe_listen_failed 是 WMI 路径
 * 起任何进程之前的本地失败——确定没有第二个 runner。
 */
export const RUNNER_LAUNCH_FAIL_REASONS = Object.freeze([
  "wmi_create_failed", // WMI（经 PowerShell）没能创建桥进程：确定没起来，不自动退回 spawn
  "payload_too_large", // 载荷帧超过大小上限（进程未起）
  "pipe_listen_failed", // 命名管道建不起来（进程未起）
  "bridge_timeout", // 总期限内桥没有连上管道：关管道，迟到的桥自己退出
  "bridge_reply_missing", // 载荷已发、回帧没收到：runner 可能已在 → 已结束并确认
  "bridge_reply_invalid", // 回帧收到但解析/形状不对：同上
  "handoff_timeout", // 回帧说 runner 活着但一直不读提示词：同上
  "prompt_handoff_timeout", // spawn 路径：提示词交接超时，runner 已被结束
  "spawn_error", // spawn 路径：spawn 抛错（detail 带原始错误）
]);

/**
 * 各失败原因的固定报错文本（调用方写 run.error / 抛错都用它，不自由发挥）。
 * wmi_create_failed 的原文点名开关——WMI 起不了时 Lead 的唯一出路。
 */
export function runnerLaunchFailureText(reason) {
  switch (reason) {
    case "wmi_create_failed":
      return "WMI 起不了进程：后台 runner 未启动；设 WAO_RUNNER_LAUNCH=spawn 可改回由本进程直接起 runner，但那样 runner 会随宿主重启 MCP 服务而死。";
    case "payload_too_large":
      return "后台 runner 启动载荷超过大小上限，runner 未启动。";
    case "pipe_listen_failed":
      return "后台 runner 启动管道创建失败，runner 未启动。";
    case "bridge_timeout":
      return "后台 runner 启动桥在期限内没有连上管道，runner 未启动。";
    case "bridge_reply_missing":
      return "后台 runner 启动桥没有回帧；可能已起的进程已被结束并确认。";
    case "bridge_reply_invalid":
      return "后台 runner 启动桥的回帧无法判读；可能已起的进程已被结束并确认。";
    case "handoff_timeout":
      return PROMPT_HANDOFF_TIMEOUT_TEXT;
    case "prompt_handoff_timeout":
      return PROMPT_HANDOFF_TIMEOUT_TEXT;
    case "spawn_error":
      return "启动后台 runner 进程失败。";
    default:
      return "后台 runner 启动失败（未知原因）。";
  }
}

/**
 * 路径选择（纯函数）：注入 spawnFn（现有测试缝）→ spawn；WAO_RUNNER_LAUNCH=spawn
 * （显式关闭开关）→ spawn；非 Windows → spawn；其余（Windows 生产缺省）→ wmi。
 */
export function resolveLaunchMode({
  platform = process.platform,
  envValue = process.env[RUNNER_LAUNCH_SPAWN_ENV],
  hasSpawnFn = false,
} = {}) {
  if (hasSpawnFn) return "spawn";
  if (envValue === "spawn") return "spawn";
  if (platform !== "win32") return "spawn";
  return "wmi";
}

/** 失败结果的构造小工具（reason 必须在闭集里——闭集外的码是编程错误，响亮抛）。 */
function startFailed(reason, extra = {}) {
  if (!RUNNER_LAUNCH_FAIL_REASONS.includes(reason)) {
    throw new Error(`runnerLaunch: unknown failure reason ${JSON.stringify(reason)}`);
  }
  return { outcome: "start_failed", runnerPid: null, reason, killConfirmed: null, killScanOk: null, ...extra };
}

// ── spawn 路径（原三处写法收进一处）──────────────────────────────────────────

/**
 * 本进程直接 detached spawn runner。stdio/env/cwd 与原先逐字节同形（prompt 交接
 * 经 stdin，stderr 是打开的 .runner-<runId>.stderr fd，打开失败退回 "ignore"，
 * spawn 之后——抛错时也要——关闭父进程自己的 fd）。
 */
async function launchViaSpawn({
  execPath, args, env, cwd, prompt, stderrPath, timeoutMs, spawnFn, openStderrFn,
}) {
  let stderrFd = null;
  try {
    stderrFd = typeof openStderrFn === "function" ? openStderrFn(stderrPath) : openSync(stderrPath, "a");
  } catch {
    stderrFd = null; // 打开失败不能阻止派发（第 89 批）
  }
  let child;
  try {
    child = spawnFn(execPath, args, {
      detached: true,
      stdio: [prompt !== null ? "pipe" : "ignore", "ignore", stderrFd === null ? "ignore" : stderrFd],
      env,
      cwd,
    });
  } catch (error) {
    if (stderrFd !== null) { try { closeSync(stderrFd); } catch { /* 已随句柄关闭 */ } }
    return startFailed("spawn_error", { detail: error });
  }
  if (stderrFd !== null) {
    try { closeSync(stderrFd); } catch { /* runner 已继承句柄，本进程的副本关掉 */ }
  }
  const handoff = await writeRunnerPrompt(child, prompt ?? "", { timeoutMs });
  if (handoff === "timeout") {
    // runner 活着却一直不读提示词：结束它（它还没起 worker），调用方按启动失败收口。
    try { child.kill(); } catch { /* 已退出 */ }
    return startFailed("prompt_handoff_timeout", { runnerPid: Number.isInteger(child.pid) ? child.pid : null });
  }
  // "runner_exited" 与 "written" 一样放行：runner 起过又退出，起不来的原因由它
  // 自己的启动失败路径落盘（与原三处行为一致）。
  child.unref();
  return { outcome: "started", runnerPid: Number.isInteger(child.pid) && child.pid > 0 ? child.pid : null };
}

// ── WMI 路径：PowerShell + Win32_Process.Create 起桥 ─────────────────────────

/** b64（UTF-8）：路径/管道名以 base64 进 PS 脚本，零引号拼接。 */
function psB64(value) {
  return Buffer.from(String(value), "utf8").toString("base64");
}

/**
 * 桥的命令行（纯函数）：`"<execPath>" "<brokerPath>" --pipe <pipe> --run-id <runId>`。
 * 不含凭据、不含 runner 长 argv；runId 过闭字母表后嵌入安全。
 */
export function buildBrokerCommandLine({ execPath, brokerPath, pipeName, runId }) {
  return `"${execPath}" "${brokerPath}" --pipe ${pipeName} --run-id ${runId}`;
}

/**
 * WMI 创建脚本（纯函数）。命令行与路径全部经 base64 交给 PowerShell（不手拼引号）；
 * 这里本来就不含凭据。ShowWindow=0 不弹窗；输出一行哨兵 wao-launch:<ReturnValue>:<ProcessId>。
 */
export function buildWmiCreateScript({ execPath, brokerPath, pipeName, runId, cwd }) {
  return [
    "$ErrorActionPreference='Stop';",
    `$exe=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${psB64(execPath)}'));`,
    `$brk=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${psB64(brokerPath)}'));`,
    `$pipe=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${psB64(pipeName)}'));`,
    `$rid=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${psB64(runId)}'));`,
    `$dir=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${psB64(cwd)}'));`,
    "$cmd='\"'+$exe+'\" \"'+$brk+'\" --pipe '+$pipe+' --run-id '+$rid;",
    // ShowWindow 是 uint16：PS 的整数字面量是 int32，直接给会 0x80041005 类型
    // 不匹配（实测）——显式 [UInt16]0。
    "$si=New-CimInstance -ClassName Win32_ProcessStartup -Property @{ShowWindow=[UInt16]0} -ClientOnly;",
    "$r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$cmd;CurrentDirectory=$dir;ProcessStartupInformation=$si};",
    "'wao-launch:'+ $r.ReturnValue + ':' + $r.ProcessId",
  ].join("\n");
}

/**
 * 哨兵判读（纯函数）：最后一条 `wao-launch:<ReturnValue>:<ProcessId>`。
 * ReturnValue=0 且 ProcessId>0 → ok（桥已创建）；ReturnValue≠0 → 创建被拒
 * （确定没起来）；没有哨兵 → 判读不出（PowerShell 在创建后、输出前失败的概率
 * 极端低，仍按 wmi_create_failed 收口）。
 */
export function parseLaunchSentinel(stdout) {
  const text = String(stdout ?? "");
  const matches = [...text.matchAll(/^wao-launch:(-?\d+):(\d+)\s*$/mg)];
  if (matches.length === 0) return { ok: false, returnValue: null, processId: null };
  const m = matches[matches.length - 1];
  const returnValue = Number(m[1]);
  const processId = Number(m[2]);
  if (returnValue === 0 && Number.isInteger(processId) && processId > 0) {
    return { ok: true, returnValue, processId };
  }
  return { ok: false, returnValue, processId };
}

/**
 * 缺省"起桥"实现：powershell.exe -NoProfile -NonInteractive -EncodedCommand 调
 * Invoke-CimMethod Win32_Process.Create。有界等待（timeoutMs），按哨兵判读；
 * 起不来 / 哨兵缺失 / ReturnValue≠0 → {ok:false, detail}（detail 是固定码/码值，
 * PS 的 stderr 尾部至多 512 字节——脚本里只有 base64 的路径与管道名，无凭据）。
 * @returns {Promise<{ok:true, pid:number}|{ok:false, detail:string}>}
 */
export function defaultWmiSpawnBroker(pipeName, {
  execPath, brokerPath, runId, cwd, timeoutMs,
  psSpawnFn = nodeSpawn,
} = {}) {
  return new Promise((resolve) => {
    const script = buildWmiCreateScript({ execPath, brokerPath, pipeName, runId, cwd });
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    let child;
    try {
      child = psSpawnFn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve({ ok: false, detail: "powershell spawn failed" });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已退出 */ }
      settle({ ok: false, detail: "powershell timeout" });
    }, Math.max(1, timeoutMs));
    child.stdout?.on("data", (c) => {
      stdout += c.toString("utf8");
      if (stdout.length > 65536) stdout = stdout.slice(-65536);
    });
    child.stderr?.on("data", (c) => {
      stderr += c.toString("utf8");
      if (stderr.length > 8192) stderr = stderr.slice(-8192);
    });
    child.on("error", () => settle({ ok: false, detail: "powershell failed to start" }));
    child.on("close", (code) => {
      const parsed = parseLaunchSentinel(stdout);
      if (parsed.ok) {
        settle({ ok: true, pid: parsed.processId });
        return;
      }
      const tail = stderr.length > 0 ? `; ${stderr.slice(0, 512)}` : "";
      settle({
        ok: false,
        detail: parsed.returnValue !== null
          ? `WMI ReturnValue=${parsed.returnValue}${tail}`
          : `no sentinel (exit=${code})${tail}`,
      });
    });
  });
}

// ── WMI 路径失败兜底：结束可能已起的 runner，确认后再报失败 ──────────────────

/** taskkill /T /F（runStop.js 同款形状）：结束进程树，永不抛。 */
function defaultTaskkill(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return { called: false, exitCode: null };
  try {
    const r = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "pipe" });
    return { called: true, exitCode: r.status };
  } catch {
    return { called: true, exitCode: null };
  }
}

/**
 * 兜底扫描脚本（纯函数；取法照 runSettle 的 defaultRunnerScan）：命令行带
 * `--run-id <id>` 或 `--resume-run-id <id>`、创建时间不早于本次启动（−5s 容差）、
 * 名为 node* 的进程，排除扫描者自身与全部祖先（祖先链带防环与步数上限）。
 * 只回传 pid 清单哨兵 `wao-killscan-ok:<n>:<pid> <pid> ...`；runId 已过闭字母表。
 */
export function buildKillScanScript(runId, notBeforeMs) {
  const pattern = (token) => `'*${token} ${runId}*'`;
  const cut = Math.trunc(notBeforeMs) - 5000;
  return [
    "$ErrorActionPreference='Stop';",
    `$cut=[DateTimeOffset]::FromUnixTimeMilliseconds(${cut}).UtcDateTime;`,
    "$ex=@(); $pp=$PID; $n=0;",
    "while ($pp -and ($ex -notcontains [string]$pp) -and $n -lt 64) { $ex+=[string]$pp; $n++;",
    "  $q=Get-CimInstance Win32_Process -Filter ('ProcessId='+$pp);",
    "  if (-not $q) { break }; $pp=$q.ParentProcessId };",
    "$all=@(Get-CimInstance Win32_Process | Where-Object { $ex -notcontains [string]$_.ProcessId });",
    "$hit=@($all | Where-Object { $_.Name -like 'node*' -and $_.CreationDate -and ($_.CreationDate.ToUniversalTime() -ge $cut) -and ($_.CommandLine -like "
      + `${pattern("--run-id")} -or $_.CommandLine -like ${pattern("--resume-run-id")}) });`,
    "'wao-killscan-ok:' + $hit.Count + ':' + ((@($hit | ForEach-Object { $_.ProcessId })) -join ' ')",
  ].join(" ");
}

/** 扫描哨兵判读（纯函数）：{ok:true, pids} | {ok:false}（扫描失败绝不读成"没有"）。 */
export function parseKillScanOutput(stdout) {
  const m = /^wao-killscan-ok:(\d+):([0-9 ]*)$/m.exec(String(stdout ?? "").trim());
  if (!m) return { ok: false };
  const pids = m[2].trim().length === 0 ? [] : m[2].trim().split(/\s+/).map(Number);
  if (pids.some((p) => !Number.isInteger(p) || p <= 0)) return { ok: false };
  return { ok: true, pids };
}

/** 缺省兜底扫描实现（execFile + PowerShell，有界）。 */
export function defaultKillScan(runId, notBeforeMs, { execFileFn = execFile, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    try {
      execFileFn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", buildKillScanScript(runId, notBeforeMs)],
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
        (err, stdout) => {
          if (err) {
            resolve({ ok: false });
            return;
          }
          resolve(parseKillScanOutput(stdout));
        },
      );
    } catch {
      resolve({ ok: false });
    }
  });
}

const defaultSleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * 结束可能已起的 runner（不得有第二个 runner）：先按已知 pid（runnerPid/桥 pid）
 * taskkill /T /F；再兜底扫描（命令行带 runId、创建时间不早于本次启动的 node
 * 进程）逐个结束；有界轮询确认全部退出。taskkill 对已退出 pid 返回非零——状态
 * 忽略，以判活为准。
 * @returns {Promise<{confirmed:boolean, killedPids:number[], scanOk:boolean}>}
 */
async function killPossiblyStartedRunner({
  runId, runnerPid, bridgePid, notBeforeMs,
  taskkillFn = defaultTaskkill,
  scanFn = defaultKillScan,
  isAliveFn = isPidAlive,
  sleepFn = defaultSleep,
}) {
  const killedPids = [];
  for (const pid of [runnerPid, bridgePid]) {
    if (Number.isInteger(pid) && pid > 0 && !killedPids.includes(pid)) killedPids.push(pid);
  }
  let scanOk = true;
  if (typeof runId === "string" && isValidRunId(runId)) {
    const scanned = await scanFn(runId, notBeforeMs);
    if (scanned && scanned.ok) {
      for (const pid of scanned.pids) {
        if (!killedPids.includes(pid)) killedPids.push(pid);
      }
    } else {
      scanOk = false; // 扫描失败：不能证明"没有第二个 runner"，如实上报
    }
  }
  for (const pid of killedPids) taskkillFn(pid);
  for (let round = 0; round < 10; round += 1) {
    const alive = killedPids.filter((pid) => isAliveFn(pid));
    if (alive.length === 0) return { confirmed: true, killedPids, scanOk };
    await sleepFn(300);
  }
  return { confirmed: false, killedPids, scanOk };
}

// ── WMI 路径：管道 + 帧交换 ──────────────────────────────────────────────────

/** 等桥连上（只接受第一个连接，随即停止监听）；期限内没连上/服务先关 → 失败。
 * 监听器必须先于"起桥"装上：net 服务对无 connection 监听时到达的连接会直接
 * 销毁——桥若在 PowerShell 退出前抢先连上，迟到装监听会把它丢掉。 */
function awaitBridgeConnection(server, deadlineMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.removeListener("connection", onConnection);
      server.removeListener("close", onClose);
      server.removeListener("error", onError);
      resolve(r);
    };
    const timer = setTimeout(() => finish({ connected: false }), Math.max(0, deadlineMs - Date.now()));
    timer.unref?.(); // 早退路径（create 失败）不留挂钟
    const onConnection = (socket) => {
      try { server.close(); } catch { /* 已关 */ } // 停止监听：只接受这第一个连接
      finish({ connected: true, socket });
    };
    const onClose = () => finish({ connected: false });
    const onError = () => finish({ connected: false });
    server.once("connection", onConnection);
    server.once("close", onClose);
    server.once("error", onError);
  });
}

/**
 * 发载荷、收回帧。回帧缺失（对端先关/错误/到期）与回帧坏（解析/形状失败）分开
 * 报——两者的失败原因码不同，兜底结束动作相同。
 * @returns {Promise<{received:true, value:object}|{received:false, kind:"reply_missing"|"reply_invalid"}>}
 */
function exchangeFrames(socket, payloadBuffer, deadlineMs) {
  return new Promise((resolve) => {
    const decoder = new FrameDecoder();
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
      try { socket.destroy(); } catch { /* 已关 */ }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ received: false, kind: "reply_missing" }), Math.max(0, deadlineMs - Date.now()));
    const onData = (chunk) => {
      try {
        const r = decoder.push(chunk);
        if (r.status === "frame") finish({ received: true, value: r.value });
      } catch {
        finish({ received: false, kind: "reply_invalid" });
      }
    };
    const onError = () => finish({ received: false, kind: "reply_missing" });
    const onClose = () => finish({ received: false, kind: "reply_missing" });
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.write(payloadBuffer);
  });
}

/**
 * WMI 路径主体。一个总期限覆盖全部步骤（开管道 → 起桥 → 等连接 → 发载荷 → 等回帧）。
 */
async function launchViaWmi({
  execPath, args, env, cwd, prompt, stderrPath, runId, timeoutMs,
  brokerPath, wmiSpawnBrokerFn, killDeps,
}) {
  const notBeforeMs = Date.now();
  const deadlineMs = notBeforeMs + Math.max(1, timeoutMs);

  // 载荷先编码：超限在起任何进程之前失败。
  let payloadBuffer;
  try {
    payloadBuffer = encodeFrame({ execPath, args, env, cwd, prompt: prompt ?? null, stderrPath });
  } catch (e) {
    if (e instanceof FrameTooLargeError) return startFailed("payload_too_large", { detail: e.message });
    throw e;
  }

  // 开管道：\\.\pipe\wao-runner-<runId>-<128bit 随机十六进制>；只接受第一个连接。
  const pipeName = `\\\\.\\pipe\\wao-runner-${runId}-${randomBytes(16).toString("hex")}`;
  const server = createServer();
  const listenOutcome = await new Promise((resolve) => {
    server.once("error", (e) => resolve({ ok: false, error: e }));
    server.listen(pipeName, () => resolve({ ok: true }));
  });
  if (!listenOutcome.ok) {
    try { server.close(); } catch { /* 未监听 */ }
    return startFailed("pipe_listen_failed", { detail: listenOutcome.error?.code ?? listenOutcome.error?.message });
  }

  try {
    // 先装连接监听、再起桥（缺省 PowerShell + WMI）——见 awaitBridgeConnection
    // 头注：无监听时到达的连接会被 net 直接销毁。
    const connPromise = awaitBridgeConnection(server, deadlineMs);

    // 起桥。ReturnValue≠0 / 起不来 → 确定没起来。这条早退路径上 connPromise 无人
    // 消费：finally 的 server.close() 让它经 'close' 落定；若极端时序下桥仍连上
    // 了，兜底销毁该连接（拿不到载荷的桥自己会退出）。
    const created = await wmiSpawnBrokerFn(pipeName, {
      execPath, brokerPath, runId, cwd, timeoutMs: Math.max(1, deadlineMs - Date.now()),
    });
    if (!created || created.ok !== true) {
      connPromise.then((r) => {
        if (r.connected) { try { r.socket.destroy(); } catch { /* 已关 */ } }
      }, () => {});
      return startFailed("wmi_create_failed", { detail: created && typeof created.detail === "string" ? created.detail : "unknown" });
    }
    const bridgePid = Number.isInteger(created.pid) && created.pid > 0 ? created.pid : null;

    // 等桥连接。期限内没连上：关管道（迟到的桥拿不到载荷会自己退出）→ 失败。
    const conn = await connPromise;
    if (!conn.connected) {
      return startFailed("bridge_timeout");
    }

    // 发载荷、收回帧。缺失/坏帧：runner 可能已经在了 → 结束并确认后失败。
    const reply = await exchangeFrames(conn.socket, payloadBuffer, deadlineMs);
    const kill = (runnerPid) => killPossiblyStartedRunner({ runId, runnerPid, bridgePid, notBeforeMs, ...killDeps });
    const killExtras = (killResult) => ({ killConfirmed: killResult.confirmed, killScanOk: killResult.scanOk });
    if (!reply.received) {
      const killResult = await kill(null);
      return startFailed(reply.kind === "reply_invalid" ? "bridge_reply_invalid" : "bridge_reply_missing", killExtras(killResult));
    }
    let validated;
    try {
      validated = validateBrokerReply(reply.value);
    } catch {
      const killResult = await kill(null);
      return startFailed("bridge_reply_invalid", killExtras(killResult));
    }
    if (validated.handoff === "timeout") {
      const killResult = await kill(validated.runnerPid);
      return startFailed("handoff_timeout", killExtras(killResult));
    }
    // "written" | "runner_exited"：runner 已起（runner_exited = 起过又退出，它的
    // 启动失败路径自己落盘——与 spawn 路径口径一致）。桥自行退出，不需要收尾。
    return { outcome: "started", runnerPid: validated.runnerPid };
  } finally {
    try { server.close(); } catch { /* 已关 */ }
  }
}

// ── 对外唯一入口 ─────────────────────────────────────────────────────────────

/**
 * 起一个后台 runner（三处调用方共用）。路径选择见 resolveLaunchMode。
 *
 * @param {object} input
 * @param {string} input.execPath — runner 的可执行文件（node）
 * @param {string[]} input.args — runner 的 argv，原样（含 --run-id/--resume-run-id 与 --prompt-stdin 摘要）
 * @param {Record<string,string>} input.env — 现在传给 spawn 的那份（含解析出的凭据值）
 * @param {string} input.cwd — 调用方此刻的 process.cwd()（继承语义的显式化；不是 runDir、不是 worker 的 --cwd）
 * @param {string|null} input.prompt — 任务书（resume 为 null）
 * @param {string} input.stderrPath — .runner-<runId>.stderr 的绝对路径
 * @param {string} input.runId
 * @param {number} [input.timeoutMs=PROMPT_HANDOFF_TIMEOUT_MS] — 总期限（覆盖 WMI 路径全部步骤 / spawn 路径的提示词交接）
 * @param {Function} [input.spawnFn] — 注入即走 spawn 路径（现有测试缝）
 * @param {Function} [input.openStderrFn] — spawn 路径 stderr 打开器（缺省真实打开；测试注入失败形状）
 * @param {Function} [input.wmiSpawnBrokerFn] — 起桥实现（缺省 PowerShell+WMI；测试注入）
 * @param {object} [input.killDeps] — 兜底结束的注入件 {taskkillFn, scanFn, isAliveFn, sleepFn}
 * @param {string} [input.brokerPath]
 * @returns {Promise<{outcome:"started", runnerPid:number|null}|
 *   {outcome:"start_failed", runnerPid:number|null, reason:string, detail?:*,
 *    killConfirmed:boolean|null, killScanOk:boolean|null}>}（killConfirmed/killScanOk
 *   只在"runner 可能已起、已做兜底结束"的失败上非 null：confirmed=已知 pid 全部
 *   确认退出；scanOk=false=兜底扫描失败，不能证明没有第二个 runner。）
 */
export async function launchRunner({
  execPath, args, env, cwd, prompt, stderrPath, runId,
  timeoutMs = PROMPT_HANDOFF_TIMEOUT_MS,
  spawnFn, openStderrFn, wmiSpawnBrokerFn, killDeps, brokerPath = DEFAULT_BROKER_PATH,
}) {
  const mode = resolveLaunchMode({ hasSpawnFn: spawnFn !== undefined && spawnFn !== null });
  if (mode === "spawn") {
    return launchViaSpawn({
      execPath, args, env, cwd, prompt, stderrPath, timeoutMs,
      spawnFn: spawnFn ?? nodeSpawn, openStderrFn,
    });
  }
  return launchViaWmi({
    execPath, args, env, cwd, prompt, stderrPath, runId, timeoutMs,
    brokerPath, wmiSpawnBrokerFn: wmiSpawnBrokerFn ?? defaultWmiSpawnBroker,
    killDeps: killDeps ?? {},
  });
}
