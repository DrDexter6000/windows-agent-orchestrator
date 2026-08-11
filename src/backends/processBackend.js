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
    runtimeEnv = () => ({}),
    spawnFn = null,
    // M12-16: optional provider wire encoder for in-flight corrections. When a
    // backend declares supportsInFlightCorrection it supplies a function
    // (text) => string that produces ONE whole stream-json user-message line
    // for that provider. The base ProcessBackend has no provider wire format,
    // so this defaults to null (non-correctable byte-compatible behavior).
    encodeUserMessage = null,
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
    this.runtimeEnv = runtimeEnv;
    // M12-16: in-flight correction wire encoder (provider-specific). null on the
    // base class → correctable tasks are rejected by capability, never by name.
    this.encodeUserMessage = typeof encodeUserMessage === "function" ? encodeUserMessage : null;
  }

  // M12-16: provider-neutral in-flight correction capability. The base
  // ProcessBackend does NOT support queuing a follow-up turn to a running child
  // (no provider wire encoder, stdin is "ignore"). A backend opts in by
  // overriding this to true AND supplying an encodeUserMessage constructor opt.
  // Shared orchestration reads this boolean — never the runtime name.
  supportsInFlightCorrection = false;

  /**
   * M11-9: provider-neutral backend policy validation. Called by RunManager
   * BEFORE any transcript append, runDir creation, worktree, or spawn.
   *
   * FAIL-CLOSED default: if the agent has ANY structured policy (model,
   * reasoning, provider) and this base class hasn't been overridden, the
   * backend cannot express it → reject. Each backend MUST override this to
   * declare exactly which fields it can translate; anything it cannot express
   * must throw. This prevents "config looks set, runtime never received it."
   *
   * @param {object} agent — normalized agent (canonical model/reasoning/provider)
   * @throws {Error} if the backend cannot express a configured policy
   */
  validateAgentPolicy(agent) {
    const hasPolicy = agent?.model || agent?.reasoning || agent?.provider;
    if (hasPolicy) {
      throw new Error(
        "this backend does not declare validateAgentPolicy — cannot confirm it can express the configured model/reasoning/provider policy",
      );
    }
  }

  /**
   * M12-14 Package 1: resolve the binary + build the full argv and run the SAME
   * compileInvocation budget check spawn runs, WITHOUT any side effect.
   * resolveBinary runs a read-only `where` query (no transcript, no worktree, no
   * spawn); buildArgs is assumed deterministic. This lets RunManager fail
   * fixed-safe BEFORE it creates a transcript, worktree, or process — when the
   * composed role contract would exceed the Windows command-line budget. cmd.exe
   * over-limit behavior is not a safe transport contract (reject/truncate/
   * misparse by boundary); WAO refuses deterministically.
   *
   * This is a best-effort EARLY gate, NOT a byte-identity guarantee: it assumes
   * buildArgs and binary resolution are deterministic and cwd-independent for the
   * configured process backends (preflight runs with the pre-worktree agent).
   * spawn re-runs compileInvocation as the authoritative defense-in-depth check,
   * so a preflight pass can never let an overflowing invocation reach the OS.
   *
   * Provider-neutral: the budget is a function of the resolved binary's
   * capability (.cmd/.bat vs .exe), never of the backend name. OpenCodeServe
   * (an HTTP backend) has no preflightInvocation and is unaffected.
   */
  async preflightInvocation(agent, task) {
    const built = await this._resolveAndBuildArgs(agent, task);
    return compileInvocation({ binary: built.binary, builtArgs: built.args, platform: process.platform });
  }

  /**
   * Shared binary+argv resolution for spawn and preflightInvocation. For the
   * configured process backends, buildArgs and binary resolution are
   * deterministic and cwd-independent, so preflight (pre-worktree) and spawn
   * (post-worktree) resolve the same { binary, args }; this is an assumption
   * about the current backends, NOT a guarantee for arbitrary injectable
   * buildArgs. spawn's own compileInvocation remains the authoritative check.
   */
  async _resolveAndBuildArgs(agent, task) {
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
    const args = [...prependArgs, ...configuredPrependArgs, ...this.buildArgs(agent, task)];
    return { binary, args };
  }

  async spawn(agent, task) {
    const built = await this._resolveAndBuildArgs(agent, task);
    // compileInvocation 是纯 kernel：保守检查 Windows 命令行预算（.cmd/.bat 含
    // /d /s /c 外包装、.exe 含引号膨胀上界），超限即固定失败。WAO 不依赖 cmd.exe
    // 超限行为（按边界可能拒绝/截断/误解析，不是安全传输契约），而是确定性拒绝。
    // 非溢出情形与旧逻辑字节级一致（binary/args/windowsVerbatimArguments 不变）。
    //
    // defense-in-depth：保留 spawn 侧复检，不复用 preflight 的预编译结果。preflight
    // 用 pre-worktree 的 agent 在副作用前先查一次；这里用 spawn 实际使用的 argv 再
    // 查一次，两次各自独立地 _resolveAndBuildArgs + compile。这【假定】当前已配置的
    // 进程式 backend 的 buildArgs 与 binary 解析是确定性的、且不依赖 cwd（preflight
    // 用源 cwd、spawn 用 worktree cwd）——这是对现有 backend 实现的假设，不是对任意
    // 可注入 buildArgs 的字节级同一性保证。保留 spawn 侧重查：即使某个 buildArgs 在
    // preflight 与 spawn 之间因 agent 状态变化而产出不同 argv，spawn 这次的
    // compileInvocation 仍是权威检查；且任何直接调用 spawn、绕过 preflight 的路径也
    // 不会漏检。
    const compiled = compileInvocation({
      binary: built.binary,
      builtArgs: built.args,
      platform: process.platform,
    });
    const binary = compiled.binary;
    const args = compiled.args;
    const windowsVerbatimArguments = compiled.windowsVerbatimArguments;
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
    const backendRuntimeEnv = this.runtimeEnv(agent, task) ?? {};
    assertRuntimeEnv(backendRuntimeEnv);
    const childEnv = buildChildEnv(inheritedNames, agentEnv, {
      ...backendRuntimeEnv,
      ...(this.waoCliPath ? { WAO_CLI: this.waoCliPath } : {}),
      WAO_TARGET_CWD: agent.cwd,
    }, resolvedCredentials);
    // Build the redactor over process.env MERGED with the resolved fallback
    // credentials, so fallback values are scrubbed from worker output too.
    const redactorEnv = { ...process.env, ...resolvedCredentials };
    const redactor = createSecretRedactor(redactorEnv, inheritedNames);
    const rawRedactor = redactor.createStream();
    // M12-16: a correctable task needs a stdin pipe so the runner can queue
    // follow-up user turns to the SAME live provider process. Only when this
    // backend declared the capability (supportsInFlightCorrection + an
    // encodeUserMessage wire encoder) does the child get a piped stdin; every
    // other run is byte-compatible (stdin "ignore").
    const correctable = task.correctable === true && this.supportsInFlightCorrection === true
      && typeof this.encodeUserMessage === "function";
    const child = this._spawnFn(binary, args, {
      cwd: agent.cwd,
      stdio: correctable ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
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

    // M12-16: deliver the initial prompt as the FIRST stream-json user message
    // on stdin (the correctable wire). The process reads its prompt from stdin
    // (claude -p --input-format stream-json), so this is byte-equivalent to the
    // positional prompt on the wire — just routed through stdin so later turns
    // can be queued to the SAME process. A write failure here is a startup
    // failure: the child cannot receive its task, so we kill it and reject.
    if (correctable) {
      const stdin = child.stdin;
      try {
        const line = `${this.encodeUserMessage(task.prompt)}\n`;
        await new Promise((resolve, reject) => {
          const ok = stdin.write(line, (err) => (err ? reject(err) : resolve()));
          // backpressure: drain before resolving so the full line is queued
          if (!ok) stdin.once("drain", resolve);
        });
      } catch (error) {
        this._kill(child);
        throw new Error(`correctable spawn failed to write initial prompt to stdin: ${error.message}`);
      }
    }

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
        onPollTick: opts.onPollTick,
        pollIntervalMs: opts.pollInterval,
        getExitCode: () => exitCode,
        getStderrTail: () => stderrTail,
        getStdoutTail: () => stdoutTail,
      }),
      abort: async () => this._kill(child),
      isAlive: () => child.exitCode === null && child.signalCode === null,
      // M12-16: in-flight correction delivery. Present ONLY on correctable runs
      // (capability-declaring backend + piped stdin). Returns {ok:true} when the
      // whole stream-json line was accepted by the runtime stdin (queued for the
      // model) — this proves byte delivery, NOT model execution. {ok:false,reason}
      // is a closed-set refusal (stdin_closed | send_failed).
      ...(correctable
        ? {
            supportsSendCorrection: true,
            sendCorrection: (text) => this._sendCorrection(child.stdin, this.encodeUserMessage, text),
          }
        : {}),
    };
  }

  /**
   * M12-16: write one correction turn to the provider child's stdin as a whole
   * stream-json user-message line. Bounded, whole-line, backpressure- and
   * closed-stdin-aware. "ok" proves the bytes were accepted by the runtime stdin
   * — NOT that the model executed the turn (queued ≠ delivered ≠ executed).
   * @returns {Promise<{ok:true}|{ok:false, reason:"stdin_closed"|"send_failed"}>}
   */
  async _sendCorrection(stdin, encodeUserMessage, text) {
    if (typeof text !== "string" || text.length === 0) return { ok: false, reason: "send_failed" };
    // Pre-check: ONLY a genuinely closed stdin is stdin_closed. Any later
    // encode/write/error is a bounded send failure (handled below).
    if (!stdin || stdin.destroyed || stdin.writableEnded
      || (typeof stdin.writable === "boolean" && !stdin.writable)) {
      return { ok: false, reason: "stdin_closed" };
    }
    try {
      const line = `${encodeUserMessage(text)}\n`;
      await new Promise((resolve, reject) => {
        let settled = false;
        // Single settle point: detach BOTH per-correction listeners (error +
        // drain) so they never accumulate across corrections, regardless of
        // whether the promise settles via the write callback, drain, an async
        // stream error, or a synchronous write throw (routed through settle
        // below).
        const settle = (err) => {
          if (settled) return;
          settled = true;
          stdin.removeListener("error", onErr);
          stdin.removeListener("drain", onDrain);
          if (err) reject(err); else resolve();
        };
        const onErr = (err) => settle(err);
        const onDrain = () => settle(null);
        stdin.once("error", onErr);
        try {
          const ok = stdin.write(line, (err) => settle(err));
          if (!ok) stdin.once("drain", onDrain);
        } catch (syncErr) {
          settle(syncErr);
        }
      });
      return { ok: true };
    } catch {
      // Closed stdin was ruled out by the pre-check; anything else (encode
      // failure, write error, a stream error mid-write) is a bounded send_failed.
      return { ok: false, reason: "send_failed" };
    }
  }

  async *_streamEvents({ queue, child, signal, silentTimeout, onPollTick = null, pollIntervalMs = null, getExitCode, getStderrTail = () => "", getStdoutTail = () => "" }) {
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
        // M12-16: in-flight correction polling. For a correctable run the runner
        // passes onPollTick; it runs in THIS loop (the single control loop that
        // also consumes backend events — no second semantic owner). A bounded
        // pollIntervalMs wait guarantees the tick fires periodically even when
        // the provider is silent, so a queued correction is claimed + delivered
        // promptly. Non-correctable runs pass no onPollTick and keep the exact
        // legacy wait cadence (byte-compatible).
        if (typeof onPollTick === "function") {
          try { await onPollTick(); } catch { /* best-effort: never kill the event stream */ }
        }
        const silentRemain = silentTimeout && !anyEventSeen
          ? Math.max(0, silentTimeout - (Date.now() - startTime))
          : Infinity;
        // When polling, bound the wait by pollIntervalMs (min with silentRemain)
        // so we wake to poll even without a backend event. Otherwise the legacy
        // indefinite/ silent-bounded wait is unchanged.
        const waitMs = (typeof onPollTick === "function" && Number.isFinite(pollIntervalMs) && pollIntervalMs > 0)
          ? Math.min(silentRemain, pollIntervalMs)
          : silentRemain;
        await new Promise((r) => {
          queue.resolveWait = r;
          if (Number.isFinite(waitMs)) setTimeout(r, waitMs);
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

function assertRuntimeEnv(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("backend runtimeEnv must return an object");
  }
  for (const [name, entry] of Object.entries(value)) {
    if (!name || typeof entry !== "string") {
      throw new Error("backend runtimeEnv entries must be non-empty string pairs");
    }
  }
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

// M12-14 Package 1: Windows process command-line budgets. Provider-neutral —
// the limit is a function of the resolved binary's capability, not the backend.
//   - WIN_CMDLINE_MAX_CMD (8191): the NOMINAL cmd.exe command-line ceiling. The
//     ACTUAL over-limit behavior is NOT a safe transport contract: depending on
//     the boundary and the Windows/build version, cmd.exe may reject, truncate,
//     or misparse the command. WAO never relies on it — it refuses deterministically
//     below the nominal ceiling (see WIN_CMDLINE_SAFETY_MARGIN).
//   - WIN_CMDLINE_MAX_EXE (32767): the CreateProcess lpCommandLine ceiling. An
//     .exe invocation that exceeds it fails loudly (CreateProcess returns an
//     error); WAO rejects conservatively before that point.
export const WIN_CMDLINE_MAX_CMD = 8191;
export const WIN_CMDLINE_MAX_EXE = 32767;
// Documented safety margin below the nominal cmd.exe ceiling. The exact .cmd/.bat
// command-line boundary is environment-dependent, so WAO rejects deterministically
// at (8191 − margin) rather than at the fuzzy nominal edge. Applied to the .cmd
// path only (the .exe 32767 ceiling is a hard CreateProcess limit).
export const WIN_CMDLINE_SAFETY_MARGIN = 64;

/**
 * Provable upper bound on the Windows-QUOTED form of a single argv element.
 *
 * libuv/CreateProcess quoting (MSDN "Parsing C Command-Line Arguments") can
 * EXPAND a source string: a run of backslashes immediately before a quote is
 * doubled, the quote is escaped as \", and the whole element is wrapped in outer
 * quotes when it contains whitespace/quotes. Every source character therefore
 * maps to at most two command-line characters, and the outer quotes add two — so
 * `2 * len + 2` is a provable upper bound on the quoted length. Used as a
 * conservative estimator so WAO never false-accepts a string whose QUOTED form
 * overflows even though its raw form fits (e.g. a long run of backslashes).
 *
 * @param {string} s — a single argv element (raw, pre-quoting)
 * @returns {number} an upper bound on its length after Windows quoting
 */
export function quotedLengthBound(s) {
  return 2 * String(s).length + 2;
}

/**
 * Conservative upper bound on the FULL lpCommandLine libuv/CreateProcess builds
 * for an invocation of `binary` with `args`: each element bounded by
 * quotedLengthBound, joined by single-space separators. Always ≥ the actual
 * command-line length, so a rejection here can never be a false success.
 *
 * @param {string} binary — resolved binary path
 * @param {string[]} args — full argv
 * @returns {number} conservative upper bound on the final command-line length
 */
export function cmdLineLengthBound(binary, args) {
  let len = quotedLengthBound(binary);
  for (const a of args) len += 1 + quotedLengthBound(a);
  return len;
}

/**
 * M12-14 Package 1: pure compile kernel shared by spawn and preflightInvocation.
 *
 * Takes an already-resolved binary and the already-built full argv and returns
 * the final { binary, args, windowsVerbatimArguments }, applying the Windows
 * .cmd/.bat wrapping AND enforcing the command-line budget as a fixed failure.
 * On non-Windows there is no process-argv budget (POSIX ARG_MAX is far larger
 * and not a truncation risk) → passed through unchanged.
 *
 * Budget model (correctness over false success):
 *   - .cmd/.bat: the FINAL command line is `<ComSpec> /d /s /c <cmdLine>` with
 *     windowsVerbatimArguments:true, so libuv passes the already-quoted cmdLine
 *     VERBATIM (no re-quoting). The bound is therefore measured over the FULL
 *     line — ComSpec (conservatively quoted-bounded) + the literal " /d /s /c "
 *     wrapper + the EXACT cmdLine length — and compared to (8191 − SAFETY_MARGIN),
 *     never to the inner cmdLine alone. cmd.exe's over-limit behavior is not a
 *     safe transport contract (reject/truncate/misparse by boundary); WAO refuses
 *     deterministically.
 *   - .exe/other: libuv applies Windows quoting (windowsVerbatimArguments:false),
 *     so the bound uses cmdLineLengthBound (a conservative quoting-aware
 *     estimator) vs 32767 — a string whose RAW join fits but whose QUOTED form
 *     overflows (e.g. a long backslash run) is rejected.
 *
 * Non-overflow behavior is BYTE-IDENTICAL to the historical spawn logic:
 *   - .cmd/.bat on win32 → wrapped via cmd.exe /d /s /c, verbatim args.
 *   - .exe / unknown on win32 → plain, no wrapping.
 *   - non-win32 → plain, no wrapping.
 * The ONLY behavioral addition is a deterministic throw when the budget would be
 * exceeded. Error messages are a fixed safe shape — they never echo argv, prompt,
 * path, or contract content.
 *
 * @param {object} input
 * @param {string} input.binary — resolved binary path
 * @param {string[]} input.builtArgs — full argv (prepend + configured + buildArgs)
 * @param {string} input.platform — process.platform (so the kernel is testable)
 * @returns {{ binary: string, args: string[], windowsVerbatimArguments: boolean }}
 * @throws {Error} on win32 when the compiled command line exceeds the budget.
 */
export function compileInvocation({ binary, builtArgs, platform }) {
  if (platform !== "win32") {
    return { binary, args: builtArgs, windowsVerbatimArguments: false };
  }
  if (isWindowsCommandScript(binary)) {
    const comspec = process.env.ComSpec || "cmd.exe";
    const cmdLine = buildCmdLine(binary, builtArgs);
    // Bound the FULL cmd.exe command line. cmdLine is passed VERBATIM
    // (windowsVerbatimArguments:true → libuv does not re-quote it), so its length
    // is exact; only ComSpec is given a conservative quoting bound. The literal
    // " /d /s /c " is the wrapper between ComSpec and the verbatim command.
    const fullLineLen = quotedLengthBound(comspec) + " /d /s /c ".length + cmdLine.length;
    if (fullLineLen > WIN_CMDLINE_MAX_CMD - WIN_CMDLINE_SAFETY_MARGIN) {
      throw new Error(
        "Windows command-script invocation exceeds the conservative command-line budget; refusing to spawn (cmd.exe over-limit behavior is not a safe transport contract)",
      );
    }
    return {
      binary: comspec,
      args: ["/d", "/s", "/c", cmdLine],
      windowsVerbatimArguments: true,
    };
  }
  // .exe / other: libuv applies Windows quoting → use the conservative quoting-
  // aware bound so a raw-join that fits but a quoted form that overflows is rejected.
  if (cmdLineLengthBound(binary, builtArgs) > WIN_CMDLINE_MAX_EXE) {
    throw new Error(
      "Windows invocation exceeds the conservative process command-line budget; refusing to spawn",
    );
  }
  return { binary, args: builtArgs, windowsVerbatimArguments: false };
}

// TD-77B：原 trimStderrTail 通用化为 trimTail（stderr/stdout 共用尾部截取）。
function trimTail(text, maxChars = 4000) {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(normalized.length - maxChars);
}
