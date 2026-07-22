import {
  messageEvent,
  doneEvent,
  metricsEvent,
  commandEvent,
  fileWrittenEvent,
  toolUseEvent,
  toolResultEvent,
} from "../runEvent.js";

// S1-1：周期性 metrics 轮询频率（每 N 轮 message 轮询取一次 session token）。
// 真实验证暴露：原版只在完成判定后取 token，失控 run 永不完成 → 预算闸门永不触发。
// 每 5 轮取一次，兼顾及时性（interval×5 ≈ 5-25s）和 HTTP 开销（不每轮都加请求）。
const METRICS_POLL_EVERY = 5;

export class OpenCodeServeBackend {
  // TD-39 / 审计 P0：HTTP-session 类 backend 的会话存活在 WAO 进程之外（serve 端持有）。
  // WAO CLI 退出 ≠ session 死。这是 fire-and-forget 路径（裸 spawn 不带 --wait）危险的根因
  // —— 孤儿 session 不经 waitForCompletion 内的三层防线（token 闸门/轮询/兜底 abort）。
  // 06-18 事故即此路径：7.4h 失控烧光半周 quota。
  // sessionOutlivesProcess 让控制平面按 backend *属性* 判定（非 runtime 名分支，runtime-agnostic）。
  sessionOutlivesProcess = true;

  // M11-5 Package A2: opencode-serve has no system/developer message channel,
  // so it cannot receive a role contract. Declared explicitly so RunManager
  // decides by capability (never by runtime name); a configured systemPrompt
  // on this backend must fail closed, not be silently dropped.
  supportsRoleContract = false;

  constructor({ fetchImpl = globalThis.fetch, timeout = 30_000, retries = 2 } = {}) {
    if (!fetchImpl) {
      throw new Error("fetch is required");
    }
    this.fetch = fetchImpl;
    this.timeout = timeout;
    this.retries = retries;
  }

  async spawn(agent, task) {
    const session = await this.createSession(agent);
    const admitted = await this.sendPrompt(agent, session.id, task.prompt);
    const serveUrl = agent.serveUrl;
    const sessionId = session.id;
    const cwd = agent.cwd;
    const completionMode = agent.completionMode ?? "snapshot-stable";
    return {
      backend: "opencode-serve",
      backendSessionId: sessionId,
      messageId: admitted.id,
      admittedSeq: admitted.admittedSeq,
      // events 工厂：RunManager 传 signal 控制超时，传 pollInterval 控制轮询频率
      events: (signal, opts) => this.streamEvents(serveUrl, sessionId, {
        cwd, signal,
        interval: opts?.pollInterval,
        completionMode,
        silentTimeout: opts?.silentTimeout,
      }),
      abort: async () => this.abort(serveUrl, sessionId),
    };
  }

  async createSession(agent) {
    const body = {
      agent: agent.agent,
      model: agent.model,
      location: { directory: agent.cwd },
    };
    const response = await this.request(`${trimSlash(agent.serveUrl)}/api/session`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return response.data;
  }

  async sendPrompt(agent, sessionId, text) {
    const messageId = `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    const body = {
      messageID: messageId,
      agent: agent.agent,
      model: {
        providerID: agent.model.providerID,
        modelID: agent.model.id,
      },
      parts: [{ type: "text", text }],
    };
    if (agent.model.variant) {
      body.variant = agent.model.variant;
    }
    const url = new URL(`${trimSlash(agent.serveUrl)}/session/${encodeURIComponent(sessionId)}/prompt_async`);
    url.searchParams.set("directory", agent.cwd);
    await this.request(url, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { id: messageId, admittedSeq: null };
  }

  async messages(serveUrl, sessionId, { cwd, limit = 50 } = {}) {
    const url = new URL(`${trimSlash(serveUrl)}/session/${encodeURIComponent(sessionId)}/message`);
    if (cwd) {
      url.searchParams.set("directory", cwd);
    }
    url.searchParams.set("limit", String(limit));
    const response = await this.request(url, { method: "GET" });
    return {
      data: response,
      cursor: { previous: null, next: null },
    };
  }

  /**
   * 取 session 级累计 metrics（tokens/cost）。
   * 比 message.info.tokens 可靠——message 的 tokens 在流式期间是 0，
   * session.tokens 是 serve 维护的累计值，message 完成即更新。
   */
  async session(serveUrl, sessionId, { cwd } = {}) {
    const url = new URL(`${trimSlash(serveUrl)}/session/${encodeURIComponent(sessionId)}`);
    if (cwd) {
      url.searchParams.set("directory", cwd);
    }
    return this.request(url, { method: "GET" });
  }

  /**
   * S1-1：尝试取 session token 并构造 metrics 事件（供周期性轮询用）。
   * 失败（endpoint 报错 / 无 token）返回 null，不阻断轮询。
   * 和完成判定路径里的 session token 提取逻辑一致，但独立为可复用方法。
   */
  async trySessionMetrics(serveUrl, sessionId, cwd) {
    try {
      const sess = await this.session(serveUrl, sessionId, { cwd });
      const t = sess?.tokens;
      if (!t) return null;
      return metricsEvent({
        input: t.input,
        output: t.output,
        reasoning: t.reasoning,
        costUsd: typeof sess.cost === "number" ? sess.cost : undefined,
      });
    } catch {
      return null;
    }
  }

  async abort(serveUrl, sessionId) {
    return this.request(`${trimSlash(serveUrl)}/session/${encodeURIComponent(sessionId)}/abort`, {
      method: "POST",
    });
  }

  async healthCheck(serveUrl) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const response = await this.fetch(`${trimSlash(serveUrl)}/api/session`, {
        method: "GET",
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      clearTimeout(timer);
      return { ok: response.ok, status: response.status };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  /**
   * 把轮询 /message 包装成 AsyncGenerator<RunEvent>。
   *
   * 职责（M1 决策）：
   *   - 看到 assistant 消息并完成后 → emit message 事件 + done(completed) 然后 return
   *   - 轮询抛错 → emit done(failed) 然后 return
   *   - signal.aborted → 立即 return（不 emit done，让 RunManager 处理超时状态）
   *
   * 两种完成判定模式（completionMode）：
   *
   * "snapshot-stable"（默认，GLM 等正常模型）：
   *   看到 assistant 后，等"快照稳定"（连续两次序列化结果相同）才 emit + done。
   *   适用于会自然停止的模型。
   *
   * "first-stable"（DeepSeek-v4-flash 等无限多轮模型）：
   *   等第一条 assistant message 出现 step-finish part（一轮完整），
   *   再确认无正在进行的新工具调用后，emit 首条 assistant + done，
   *   然后立即调 abort 终止 serve 端 session（停止后台 token 消耗）。
   *   不等待后续的重复确认消息（DeepSeek 回答后会无限重复）。
   *
   * 不负责超时判定——waitTimeout 由 RunManager 通过 signal 控制。
   */
  async *streamEvents(serveUrl, sessionId, { cwd, signal, interval = 1000, completionMode = "snapshot-stable", silentTimeout } = {}) {
    if (completionMode === "first-stable") {
      yield* this.streamEventsFirstStable(serveUrl, sessionId, { cwd, signal, interval, silentTimeout });
      return;
    }
    yield* this.streamEventsSnapshotStable(serveUrl, sessionId, { cwd, signal, interval, silentTimeout });
  }

  /**
   * snapshot-stable 模式（原 M1/M2 逻辑）。
   * 等快照稳定后才 emit 所有 message + done。
   */
  async *streamEventsSnapshotStable(serveUrl, sessionId, { cwd, signal, interval = 1000, silentTimeout }) {
    let lastSnapshot = "";
    let assistantSeen = false;
    const startTime = Date.now();
    let pollCount = 0;
    while (!signal?.aborted) {
      let msgs;
      try {
        const { data } = await this.messages(serveUrl, sessionId, { cwd, limit: 50 });
        msgs = Array.isArray(data) ? data : [];
      } catch (error) {
        yield doneEvent("failed", error.message ?? String(error));
        return;
      }
      pollCount += 1;
      // S1-1 修复（2026-06-23 真实验证暴露）：周期性 yield metrics 事件。
      // 原版只在 completed 判定后才取 session token → 失控 run 永不完成 → 永不 emit metrics
      // → token 预算闸门（挂在 metrics 事件上）永不触发。现每 metricsPollEvery 轮主动取
      // session token 并 yield，让闸门能在 run 进行中检测到 token 增长。
      if (pollCount % METRICS_POLL_EVERY === 0) {
        const metricsEv = await this.trySessionMetrics(serveUrl, sessionId, cwd);
        if (metricsEv) yield metricsEv;
      }
      // 静默早失败（codex 实测建议）：若超过 silentTimeout 仍无 assistant message，
      // 说明 provider 静默拒绝（Kimi 白名单 / 不存在的 model，serve 不产 error 也不产 assistant）。
      // 不等完整 waitTimeout，直接 done(failed)。
      if (!assistantSeen && silentTimeout && (Date.now() - startTime) > silentTimeout) {
        yield doneEvent("failed", `silent timeout: no assistant response within ${silentTimeout}ms (provider may have silently rejected)`);
        return;
      }
      const snapshot = JSON.stringify(msgs);
      // provider 错误检测（事故修复 2026-06-17）：opencode serve 把 provider 错误
      //（401/欠费/限流）包成 assistant message 的 error 字段，parts 为空数组。
      // 旧逻辑只看 parts.length>0，看不到它 → 卡 submitted 烧超时。
      // 现检测到 error 立即 done(failed) + 透传错误详情，秒级失败。
      // 注意：排除 MessageAbortedError——那是我们自己的 abort 副作用（first-stable /
      // _runCleanup 调 abort 后 serve 产生的尾随 message），不是 provider 错误。
      const errMsg = msgs.find(
        (m) => m.info?.role === "assistant" && m.info?.error &&
               m.info.error.name !== "MessageAbortedError",
      );
      if (errMsg) {
        const e = errMsg.info.error;
        const detail = e.data?.message ?? e.name ?? "provider_error";
        const code = e.data?.statusCode ? ` [${e.data.statusCode}]` : "";
        yield doneEvent("failed", `provider error${code}: ${detail}`);
        return;
      }
      // assistant "出现"判定：必须有非 step-start 的 part（真实内容：text/tool/step-finish）。
      // 只剩 step-start 是流式占位符，此时 info.tokens 还是 {0,0}，
      // 会被误判为"已完成"并提取 0-token metrics（bug 修复 2026-06-17）。
      const hasAssistant = msgs.some(
        (m) => m.info?.role === "assistant" &&
               m.parts?.some((p) => p.type !== "step-start"),
      );
      if (hasAssistant) {
        if (!assistantSeen) {
          assistantSeen = true;
          lastSnapshot = snapshot;
          await sleep(interval);
          continue;
        }
        if (snapshot === lastSnapshot) {
          // 完成判据（codex 实测修复 2026-06-17）：快照稳定还不够——
          // 必须至少一条 assistant message 有非空 text part（答案）。
          // GLM 实测会在 tool-call 轮给 step-finish 但无 text（读完文件没答），
          // 旧逻辑此时判 completed → 伪完成（assistantTextCount=0）。
          // 无 text 则继续等（模型可能还在后续轮给答案）。
          const hasTextAnswer = msgs.some(
            (m) => m.info?.role === "assistant" &&
                   m.parts?.some((p) => p.type === "text" && p.text),
          );
          if (!hasTextAnswer) {
            // 快照稳定但无 text 答案——重置观察状态继续等，不判 completed
            assistantSeen = false;
            lastSnapshot = "";
            await sleep(interval);
            continue;
          }
          for (const m of msgs) {
            if (m.info?.role && m.parts) {
              for (const ev of evidenceEventsFromOpenCodeMessage(m)) {
                yield ev;
              }
              yield messageEvent(m.info.role, m.parts);
            }
          }
          // metrics：用 session 级累计 tokens（比 message.info.tokens 可靠——
          // message 的 tokens 在流式期间是 0，session.tokens 是 serve 维护的累计值）。
          try {
            const sess = await this.session(serveUrl, sessionId, { cwd });
            const t = sess?.tokens;
            if (t) {
              yield metricsEvent({
                input: t.input,
                output: t.output,
                reasoning: t.reasoning,
                costUsd: typeof sess.cost === "number" ? sess.cost : undefined,
              });
            }
          } catch {
            // session metrics 取不到不阻断完成（done 照常 emit）
          }
          yield doneEvent("completed");
          return;
        }
        lastSnapshot = snapshot;
      }
      await sleep(interval);
    }
  }

  /**
   * first-stable 模式（解决 DeepSeek-v4-flash 等模型的无限多轮）。
   *
   * 判定完成条件（全部满足）：
   *   1. 第一条 assistant message 存在
   *   2. 它有 step-finish part（一轮 LLM 调用完整结束）
   *   3. step-finish 作为完成信号，不再额外等待确认轮
   *
   * 完成后：
   *   - emit user message + 首条 assistant message + metrics + done(completed)
   *   - 立即调 abort 终止 serve 端 session（防止后台继续烧 token）
   */
  async *streamEventsFirstStable(serveUrl, sessionId, { cwd, signal, interval = 1000, silentTimeout }) {
    const startTime = Date.now();
    let pollCount = 0;
    while (!signal?.aborted) {
      let msgs;
      try {
        const { data } = await this.messages(serveUrl, sessionId, { cwd, limit: 50 });
        msgs = Array.isArray(data) ? data : [];
      } catch (error) {
        yield doneEvent("failed", error.message ?? String(error));
        return;
      }
      pollCount += 1;
      // S1-1 修复：周期性 yield metrics（同 snapshot-stable），让预算闸门能在 first-stable
      // 等待首条 text 答案期间也检测到 token 增长。
      if (pollCount % METRICS_POLL_EVERY === 0) {
        const metricsEv = await this.trySessionMetrics(serveUrl, sessionId, cwd);
        if (metricsEv) yield metricsEv;
      }

      // 静默早失败：同 snapshot-stable。
      const hasAnyAssistant = msgs.some((m) => m.info?.role === "assistant");
      if (!hasAnyAssistant && silentTimeout && (Date.now() - startTime) > silentTimeout) {
        yield doneEvent("failed", `silent timeout: no assistant response within ${silentTimeout}ms (provider may have silently rejected)`);
        return;
      }

      // provider 错误检测（事故修复 2026-06-17）：同 snapshot-stable。
      // 必须在 firstAssistantFinished 判定之前——否则 step-finish 永远不出现，
      // error message 也被忽略，卡到超时。
      // 排除 MessageAbortedError（我们 abort 的副作用，非 provider 错误）。
      const errMsg = msgs.find(
        (m) => m.info?.role === "assistant" && m.info?.error &&
               m.info.error.name !== "MessageAbortedError",
      );
      if (errMsg) {
        const e = errMsg.info.error;
        const detail = e.data?.message ?? e.name ?? "provider_error";
        const code = e.data?.statusCode ? ` [${e.data.statusCode}]` : "";
        yield doneEvent("failed", `provider error${code}: ${detail}`);
        return;
      }

      // C' 完成判据（2026-06-17 实测重设计）：
      // 首条含非空 text part 的 assistant message 即"给出答案"→ 完成。
      // 旧判据看 step-finish，但 DeepSeek 每轮（含工具轮）都 emit step-finish →
      // 多轮任务在工具轮就被截断（msg[0] 有 tool+step-finish 但无 text）。
      // 实测证据：msg[0]=[step-start,reasoning,tool,tool,step-finish]（无 text，还在干活），
      // msg[1]=[step-start,reasoning,text,step-finish]（首条 text=答案）。
      // "有 text part" 精确区分"还在干活"和"给出答案"。
      const firstAssistantFinished = msgs.find(
        (m) => m.info?.role === "assistant" &&
               m.parts?.some((p) => p.type === "text" && p.text),
      );
      if (firstAssistantFinished) {
        // 一旦首条 assistant 给出 text 答案，先取 session metrics（abort 前取，值最准），
        // 再发送 abort，最后交付 done。
        // DeepSeek-v4-flash 会在首轮结束后立刻开下一轮；多等一轮就是 token 泄漏窗口。
        let sessionMetrics = null;
        try {
          const sess = await this.session(serveUrl, sessionId, { cwd });
          if (sess?.tokens) {
            sessionMetrics = {
              tokens: sess.tokens,
              cost: typeof sess.cost === "number" ? sess.cost : undefined,
            };
          }
        } catch {
          // session metrics 取不到用 message 级兜底
        }
        try {
          await this.abort(serveUrl, sessionId);
        } catch {
          // abort 失败不影响已取得的首轮结果
        }
        for (const m of msgs) {
          for (const ev of evidenceEventsFromOpenCodeMessage(m)) {
            yield ev;
          }
        }
        for (const m of msgs) {
          if (m.info?.role === "user" && m.parts) {
            yield messageEvent("user", m.parts);
          }
        }
        yield messageEvent("assistant", firstAssistantFinished.parts);
        // metrics：优先 session endpoint 累计值（真实），回退 message.info.tokens
        const t = sessionMetrics?.tokens ?? firstAssistantFinished.info?.tokens;
        if (t) {
          yield metricsEvent({
            input: t.input,
            output: t.output,
            reasoning: t.reasoning,
            costUsd: sessionMetrics?.cost ?? (typeof firstAssistantFinished.info?.cost === "number" ? firstAssistantFinished.info.cost : undefined),
          });
        }
        yield doneEvent("completed");
        return;
      }

      await sleep(interval);
    }
    // signal 被 abort（超时），流静默结束
  }

  async request(url, init) {
    let lastError;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeout);
        const response = await this.fetch(url, {
          ...init,
          signal: controller.signal,
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            ...(init.headers ?? {}),
          },
        });
        clearTimeout(timer);
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`OpenCode request failed ${response.status}: ${text}`);
        }
        if (response.status === 204) {
          return null;
        }
        return response.json();
      } catch (error) {
        lastError = error;
        const retryable = error.name === "AbortError" || isTransient(error);
        if (!retryable || attempt === this.retries) break;
        await sleep(1000 * 2 ** attempt);
      }
    }
    throw lastError;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransient(error) {
  const msg = error.message ?? "";
  if (error.cause?.code === "ECONNREFUSED") return true;
  if (error.cause?.code === "ECONNRESET") return true;
  if (msg.includes("fetch failed")) return true;
  return false;
}

function trimSlash(value) {
  return value.replace(/\/+$/, "");
}

function evidenceEventsFromOpenCodeMessage(message) {
  if (!Array.isArray(message?.parts)) return [];
  const events = [];
  for (const part of message.parts) {
    if (part?.type !== "tool") continue;
    events.push(...evidenceEventsFromOpenCodeToolPart(part));
  }
  return events;
}

function evidenceEventsFromOpenCodeToolPart(part) {
  const tool = String(part.tool ?? part.name ?? "unknown");
  const toolKey = tool.toLowerCase();
  const input = part.state?.input ?? part.input ?? {};
  const output = part.state?.output ?? part.output ?? part.state?.metadata?.output;
  const metadata = part.state?.metadata ?? part.metadata ?? {};
  const callId = part.callID ?? part.callId ?? part.id ?? part.toolCallId ?? tool;
  const status = part.state?.status ?? part.status;
  const exitCode = readExitCode(part, metadata);
  const isError = inferToolIsError(status, exitCode);
  const events = [];

  if ((toolKey === "bash" || toolKey === "shell") && typeof input.command === "string") {
    events.push(commandEvent(input.command, exitCode, { toolCallId: callId }));
  } else if (isFileWriteTool(toolKey)) {
    const filePath = input.filePath ?? input.file_path ?? input.path;
    if (typeof filePath === "string") {
      events.push(fileWrittenEvent(filePath));
    }
  } else {
    events.push(toolUseEvent(tool, input));
  }

  if (isTerminalToolStatus(status) || typeof exitCode === "number") {
    events.push(toolResultEvent(callId, output, isError));
  }
  return events;
}

function isFileWriteTool(toolKey) {
  return toolKey === "write" || toolKey === "edit" || toolKey === "multiedit";
}

function readExitCode(part, metadata) {
  for (const value of [
    metadata.exit,
    metadata.exitCode,
    metadata.exit_code,
    part.state?.exitCode,
    part.state?.exit_code,
    part.exitCode,
    part.exit_code,
  ]) {
    if (typeof value === "number") return value;
  }
  return undefined;
}

function inferToolIsError(status, exitCode) {
  if (typeof exitCode === "number") return exitCode !== 0;
  return status === "error" || status === "failed";
}

function isTerminalToolStatus(status) {
  return status === "completed" || status === "error" || status === "failed";
}
