import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { doneEvent } from "../runEvent.js";
import { createSecretRedactor, isSecretEnvName } from "../secretRedaction.js";

const SAFE_INHERITED_ENV = new Set([
  "ALL_PROXY", "APPDATA", "COLORTERM", "COMSPEC", "HOMEDRIVE", "HOMEPATH",
  "HTTP_PROXY", "HTTPS_PROXY", "LANG", "LC_ALL", "LOCALAPPDATA", "NODE_EXTRA_CA_CERTS",
  "NO_PROXY", "NUMBER_OF_PROCESSORS", "OS", "PATH", "PATHEXT", "PROCESSOR_ARCHITECTURE",
  "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "SSL_CERT_DIR",
  "SSL_CERT_FILE", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "TERM", "TMP", "USERDOMAIN",
  "USERNAME", "USERPROFILE", "WINDIR",
]);

/**
 * 事件队列：把 parser 产出的事件和进程 close 信号汇成一条流。
 * 每个 handle 独立一个实例（不跨 run 共享）。
 */
class EventQueue {
  constructor() {
    this.items = [];
    this.resolveWait = null;
    this.closed = false;
    this.sawDone = false;
  }
  push(events) {
    for (const ev of events) {
      if (ev.kind === "done") this.sawDone = true;
      this.items.push(ev);
    }
    this._kick();
  }
  _kick() {
    if (this.resolveWait) {
      const r = this.resolveWait;
      this.resolveWait = null;
      r();
    }
  }
  markClosed() {
    this.closed = true;
    this._kick();
  }
  drain() {
    return this.items.splice(0);
  }
  hasItems() {
    return this.items.length > 0;
  }
}

/**
 * 通用进程式 Backend（M2-5）。
 *
 * 驱动子进程，把 stdout 喂给 parser，产出 RunEvent 流。
 * 不知道格式细节——格式逻辑全在注入的 parserClass 里。
 *
 * 职责：
 *   - spawn: 启动子进程，建 parser，返回 handle
 *   - events(signal): AsyncGenerator，从 parser 拿事件 yield；进程退出 + flush 后若无 done 则按 exit code 兜底
 *   - abort: 杀进程树（Windows: taskkill /pid /T /F）—— 主动 abort 路径
 *
 * 进程式 session = 子进程；进程死了 session 就没了（resume 不可能，见 TD-10）。
 *
 * TD-40 进程隔离（"进程死即会话死"）的双重保证，互补非二选一：
 *   (a) Node 内置 Job Object（被动，OS 级）：自 v18+ libuv 把 spawn 子进程绑进 Job Object
 *       （JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE），父进程退出 → OS 自动杀全部子进程树。
 *       v22 上正常工作；v24 是该内置机制回归 → 被 nodeVersionGuard + engines 拒绝。
 *   (b) taskkill /pid /T /F（主动）：abort 时主动杀进程树（行业最佳实践，tree-kill/execa 底层同此）。
 * 不实现自定义 Job Object：违反零依赖（需 N-API/FFI 原生模块）且业界无人这样做（内置已够用，见 ADR 0013）。
 */
export class ProcessBackend {
  constructor({
    parserClass,
    buildArgs,
    timeout = 30_000,
    retries = 0,
    waoCliPath = null,
    rawCapturePath = null,
    credentialEnvNames = () => [],
    spawnFn = null,
  } = {}) {
    if (!parserClass) throw new Error("parserClass is required");
    if (!buildArgs) throw new Error("buildArgs is required");
    this.parserClass = parserClass;
    this.buildArgs = buildArgs;
    this.timeout = timeout;
    // 进程式不像 HTTP 可重试——默认 retries:0。M2 明确禁用进程级重试。
    this.retries = retries;
    // WAO CLI 路径（注入 worker env，让 worker 能调 wao decision/handoff 记录状态）。
    // 由 cli.js 的 backendFor 构造时传入。
    this.waoCliPath = waoCliPath;
    // M11-7: injectable spawn (default: node child_process.spawn) for tests that
    // need to inspect the child env / redaction without launching a real process.
    this._spawnFn = spawnFn ?? spawn;
    // TD-76 raw-capture：可开关旁路日志，捕获 parser 输入前的原始 stdout（每 chunk 追加写）。
    // 默认 null（关）。注入优先级：构造参数 > WAO_RAW_CAPTURE env（env 便于一次性调研，
    // 无需改代码/签名）。用途：抓 thinking/schema 等 raw 形态做调研（不臆测，守 decision 0009
    // 纪律）。不影响 transcript。注意：env 形态多 run 会追加写同一文件——单次调研用，正式
    // 按 run 隔离走构造参数（未来 backendFor 传 runId）。
    this.rawCapturePath = rawCapturePath ?? (process.env.WAO_RAW_CAPTURE || null);
    this.credentialEnvNames = credentialEnvNames;
  }

  async spawn(agent, task) {
    // resolveBinary 可返回字符串或 { binary, prependArgs }
    // （后者用于绕过 .cmd 包装器，直接 node 跑 .js 入口）
    let binary = agent.binary;
    let prependArgs = [];
    if (!binary) {
      const resolved = await this.resolveBinary(agent);
      if (typeof resolved === "string") {
        binary = resolved;
      } else {
        binary = resolved.binary;
        prependArgs = resolved.prependArgs ?? [];
      }
    }
    const configuredPrependArgs = Array.isArray(agent.prependArgs) ? agent.prependArgs : [];
    let args = [...prependArgs, ...configuredPrependArgs, ...this.buildArgs(agent, task)];
    let windowsVerbatimArguments = false;
    if (process.platform === "win32" && isWindowsCommandScript(binary)) {
      args = ["/d", "/s", "/c", buildCmdLine(binary, args)];
      binary = process.env.ComSpec || "cmd.exe";
      windowsVerbatimArguments = true;
    }
    const agentEnv = agent.env ?? {};
    const forbiddenAgentEnv = Object.keys(agentEnv).find(isSecretEnvName);
    if (forbiddenAgentEnv) {
      throw new Error(`secret-like agent.env key is not allowed: ${forbiddenAgentEnv}`);
    }
    const inheritedNames = this.credentialEnvNames(agent);
    // M11-7: resolvedCredentials carries credential VALUES resolved from the
    // Windows user env (when not present in process.env). Passed in by the
    // caller (backgroundRunner / RunManager) so the child env AND the redactor
    // both cover them — preventing both "credential missing" crashes and
    // stdout/stderr secret leaks of the fallback values.
    const resolvedCredentials = task.resolvedCredentials ?? {};
    const childEnv = buildChildEnv(inheritedNames, agentEnv, {
      ...(this.waoCliPath ? { WAO_CLI: this.waoCliPath } : {}),
      WAO_TARGET_CWD: agent.cwd,
    }, resolvedCredentials);
    // Build the redactor over process.env MERGED with the resolved fallback
    // credentials, so fallback values are scrubbed from worker output too.
    const redactorEnv = { ...process.env, ...resolvedCredentials };
    const redactor = createSecretRedactor(redactorEnv, inheritedNames);
    const rawRedactor = redactor.createStream();
    const child = this._spawnFn(binary, args, {
      cwd: agent.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments,
      // 注入 WAO env：让 worker 能调 wao 命令记录状态（角色 prompt 教 worker 用 $WAO_CLI）。
      // WAO_CLI = WAO 的 cli.js 路径；WAO_TARGET_CWD = worker 当前干活的目标项目（用于 wao 命令的 --cwd）。
      // TD-79：agent.env（registry 声明）注入子进程——如 PIP_REQUIRE_VIRTUALENV 让 pip 拒绝
      // 安装，防 read-only worker（researcher）跑 pip install 污染全局 Python env。
      env: childEnv,
    });

    // spawn 失败（ENOENT 等）会 emit 'error' 事件而非抛错。
    // 包成 Promise 让调用方能 await 捕获；成功时 resolve，失败时 reject。
    const spawned = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", resolve);
    });

    const parser = new this.parserClass();
    const pid = child.pid;
    const sessionId = `proc_${pid}`;
    const queue = new EventQueue();
    let exitCode = null;
    let stderrTail = "";
    // TD-77 子项 B：stdout 也留尾部摘要。进程崩时往往没写 stderr（物理缺失），
    // 旧 detail 退化为 "process exited with code N"，Lead 看不到 worker 崩前 stdout 吐了什么。
    // 现无 stderr 时回落到 stdout 尾，让诊断不再黑盒化。
    // 注意：与 TD-76 rawCapture 并存——rawCapture 是旁路全量文件（调研用），
    // stdoutTail 是内存尾部摘要（供诊断 detail），两者独立。
    let stdoutTail = "";

    child.stdout.on("data", (chunk) => {
      // TD-76 raw-capture：parser 输入前留一份原始 stdout（旁路文件，不影响 transcript）。
      // 同步写防乱序；失败静默（调研工具，不应影响 run）。
      if (this.rawCapturePath) {
        try { appendFileSync(this.rawCapturePath, rawRedactor.write(chunk), "utf8"); } catch { /* 调研工具，失败不阻塞 */ }
      }
      // TD-77B：累积 stdout 尾部摘要（parser 仍吃全量 chunk，这里只是镜像截取尾部供诊断）。
      stdoutTail = trimTail(redactor.redactString(stdoutTail + chunk.toString("utf8")));
      queue.push(parser.feed(chunk));
    });
    child.stderr.on("data", (chunk) => {
      // stderr 不作为正常事件流解析（codex 的非 JSON 日志有些走 stderr）。
      // 但失败兜底时保留尾部摘要，避免 provider/CLI 错误黑盒化。
      stderrTail = trimTail(redactor.redactString(stderrTail + chunk.toString("utf8")));
    });
    child.on("close", (code) => {
      if (this.rawCapturePath) {
        try { appendFileSync(this.rawCapturePath, rawRedactor.end(), "utf8"); } catch { /* 调研工具，失败不阻塞 */ }
      }
      exitCode = code;
      queue.push(parser.flush());
      queue.markClosed();
    });

    // 若 spawn 本身失败（ENOENT），这里 reject，调用方 catch
    await spawned;

    return {
      backend: "process",
      backendSessionId: sessionId,
      messageId: undefined,
      admittedSeq: undefined,
      redact: (value) => redactor.redact(value),
      events: (signal, opts = {}) => this._streamEvents({
        queue,
        child,
        signal,
        silentTimeout: opts.silentTimeout,
        getExitCode: () => exitCode,
        getStderrTail: () => stderrTail,
        getStdoutTail: () => stdoutTail,
      }),
      abort: async () => this._kill(child),
      isAlive: () => child.exitCode === null && child.signalCode === null,
    };
  }

  async *_streamEvents({ queue, child, signal, silentTimeout, getExitCode, getStderrTail = () => "", getStdoutTail = () => "" }) {
    let emittedDone = false;
    let anyEventSeen = false;
    const startTime = Date.now();
    const onAbort = () => this._kill(child);
    if (signal) signal.addEventListener("abort", onAbort);

    try {
      while (true) {
        // 排空队列
        for (const ev of queue.drain()) {
          if (ev.kind === "done") emittedDone = true;
          if (!anyEventSeen) anyEventSeen = true;
          yield ev;
        }
        if (queue.closed && queue.hasItems()) continue;
        if (queue.closed) {
          // 进程已退出。若无 done，按 exit code 兜底
          if (!emittedDone && !queue.sawDone) {
            const code = getExitCode();
            if (code === 0) {
              yield doneEvent("completed");
            } else {
              // TD-77 子项 B：stderr 优先；无 stderr 时回落到 stdout 尾部摘要。
              // 进程崩时往往没写 stderr（物理缺失），旧实现只给 exit code 让诊断黑盒化。
              // 现无 stderr 时用 stdout 尾，让 Lead 至少看到 worker 崩前吐了什么。
              const stderr = getStderrTail();
              const stdout = getStdoutTail();
              const detail = stderr
                ? `process exited with code ${code}; stderr: ${stderr}`
                : (stdout
                  ? `process exited with code ${code}; stdout: ${stdout}`
                  : `process exited with code ${code}`);
              yield doneEvent("failed", detail);
            }
          }
          return;
        }
        // TD-A 静默早失败：silentTimeout 内若无任何 parser 事件，说明 provider 静默拒绝
        // （重试死循环 / 白名单 / 不存在的 model，进程活着但不产出）。
        // 语义对齐 opencodeServe.streamEventsSnapshotStable。不等 waitTimeout，直接 done(failed)。
        if (silentTimeout && !anyEventSeen && (Date.now() - startTime) > silentTimeout) {
          yield doneEvent(
            "failed",
            `silent timeout: no events within ${silentTimeout}ms (process still running; provider may have silently rejected)`,
          );
          this._kill(child);
          return;
        }
        // 等待新事件或 close。
        // 若启用了 silentTimeout 且尚未见事件，用有界等待（到期回来重新检查 silentTimeout）；
        // 否则无界等待（向后兼容，靠 signal abort 唤醒）。
        const silentRemain = silentTimeout && !anyEventSeen
          ? Math.max(0, silentTimeout - (Date.now() - startTime))
          : Infinity;
        await new Promise((r) => {
          queue.resolveWait = r;
          if (Number.isFinite(silentRemain)) setTimeout(r, silentRemain);
        });
      }
    } finally {
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  _kill(child) {
    if (!child || child.exitCode !== null || child.signalCode) return;
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    } catch {
      try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
    }
  }

  defaultBinary(agent) {
    throw new Error(`agent ${agent.id} missing binary for process backend`);
  }

  /**
   * 探测真实可执行路径。解决 Windows 上 codex 是 codex.cmd、
   * child_process.spawn 不自动补 .cmd 扩展名的问题。
   * where 可能返回多个（codex shell 脚本 + codex.cmd），优先选有扩展名的。
   * 非 Windows 直接返回 name（走 PATH）。
   */
  async resolveBinary(agent) {
    const name = this.defaultBinary(agent);
    if (process.platform !== "win32") return name;
    try {
      const { execSync } = await import("node:child_process");
      const out = execSync(`where ${name}`, { encoding: "utf8", windowsHide: true });
      const paths = out.split(/\r?\n/).filter(Boolean);
      // 优先 .exe > .cmd > .bat > 无扩展名（无扩展名的是 Unix shell 脚本，spawn 跑不了）
      const ranked = paths.sort((a, b) => {
        const score = (p) => {
          if (p.toLowerCase().endsWith(".exe")) return 3;
          if (p.toLowerCase().endsWith(".cmd")) return 2;
          if (p.toLowerCase().endsWith(".bat")) return 1;
          return 0;
        };
        return score(b) - score(a);
      });
      return ranked[0] || name;
    } catch {
      return name;
    }
  }
}

function buildChildEnv(inheritedNames, agentEnv, waoEnv, resolvedCredentials = {}) {
  const requested = new Set(
    [...SAFE_INHERITED_ENV, ...(inheritedNames ?? [])]
      .filter((name) => typeof name === "string" && name.length > 0)
      .map((name) => name.toUpperCase()),
  );
  const inherited = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (requested.has(name.toUpperCase())) inherited[name] = value;
  }
  // M11-7: merge registry-declared credentials resolved from the Windows user
  // env (when absent from process.env). These take precedence over any stale
  // process.env value but below agent.env/waoEnv. They are also fed to the
  // redactor below so they are scrubbed from worker stdout/stderr/transcript.
  const credEnv = {};
  for (const [name, value] of Object.entries(resolvedCredentials ?? {})) {
    if (requested.has(name.toUpperCase()) && typeof value === "string") {
      credEnv[name] = value;
    }
  }
  return { ...inherited, ...credEnv, ...agentEnv, ...waoEnv };
}

function isWindowsCommandScript(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".cmd" || ext === ".bat";
}

function buildCmdLine(binary, args) {
  return ["call", quoteCmdArg(binary), ...args.map(quoteCmdArg)].join(" ");
}

function quoteCmdArg(value) {
  const text = String(value);
  if (text.length === 0) return "\"\"";
  return `"${text.replace(/%/g, "%%").replace(/"/g, "\\\"")}"`;
}

// TD-77B：原 trimStderrTail 通用化为 trimTail（stderr/stdout 共用尾部截取）。
function trimTail(text, maxChars = 4000) {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(normalized.length - maxChars);
}
