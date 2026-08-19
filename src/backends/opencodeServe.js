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
const OPENCODE_NATIVE_SYSTEM_MIN_VERSION = Object.freeze([1, 18, 0]);

export class OpenCodeServeBackend {
  // TD-39 / 审计 P0：HTTP-session 类 backend 的会话存活在 WAO 进程之外（serve 端持有）。
  // WAO CLI 退出 ≠ session 死。这是 fire-and-forget 路径（裸 spawn 不带 --wait）危险的根因
  // —— 孤儿 session 不经 waitForCompletion 内的三层防线（token 闸门/轮询/兜底 abort）。
  // 06-18 事故即此路径：7.4h 失控烧光半周 quota。
  // sessionOutlivesProcess 让控制平面按 backend *属性* 判定（非 runtime 名分支，runtime-agnostic）。
  sessionOutlivesProcess = true;

  // OpenCode 1.18 exposes a native `system` field on the message endpoint.
  // RunManager may therefore use the same role-contract capability boundary as
  // the process backends; the task remains a separate user text part.
  supportsRoleContract = true;

  // ADR-0025 批次 2（TD-87）：session.tokens 周期轮询（METRICS_POLL_EVERY）
  // 产出 metrics token 事实——tokenBudget 闸门对该 backend 有效（C3/06-18
  // 事故防线要求 opencode worker 必配 tokenBudget 的喂料基础）。
  reportsTokenUsage = true;

  /**
   * The `system` transport is runtime-versioned. Prove it before RunManager
   * creates a transcript or worktree; a static capability flag alone is not
   * sufficient for an externally managed server.
   */
  async validateRoleContractTransport(agent, { roleContract } = {}) {
    if (typeof roleContract !== "string" || roleContract.length === 0) return;
    try {
      const response = await this.request(`${trimSlash(agent.serveUrl)}/global/health`, {
        method: "GET",
      });
      const health = response?.data ?? response;
      if (
        health?.healthy === true
        && isVersionAtLeast(health.version, OPENCODE_NATIVE_SYSTEM_MIN_VERSION)
      ) {
        return;
      }
    } catch {
      // Project no network/provider details through this pre-side-effect gate.
    }
    throw new Error("opencode-serve role contract transport is unavailable");
  }

  /**
   * M11-9 capability: OpenCodeServe uses its own legacy model shape
   * (string or {providerID, id, variant}) — NOT the canonical {id, contextWindow}.
   * It cannot express canonical reasoning, provider, or contextWindow.
   * The canonical model shape (which has contextWindow or lacks providerID) is
   * rejected; the OpenCode legacy shape ({providerID, id, variant}) is accepted.
   */
  validateAgentPolicy(agent) {
    if (agent?.reasoning?.effort) {
      throw new Error("opencode-serve backend cannot express reasoning.effort");
    }
    if (agent?.provider) {
      throw new Error("opencode-serve backend cannot express provider");
    }
    // Reject canonical model {id, contextWindow} (no providerID → not OpenCode shape).
    // Accept OpenCode legacy {providerID, id, variant}.
    if (agent?.model && typeof agent?.model === "object") {
      if (agent.model.contextWindow !== undefined) {
        throw new Error("opencode-serve backend cannot express model.contextWindow");
      }
      // Canonical shape has bare {id} without providerID — reject.
      if (agent.model.id !== undefined && agent.model.providerID === undefined) {
        throw new Error("opencode-serve backend uses its own model shape ({providerID, id, variant}), not canonical {id, contextWindow}");
      }
    }
  }

  constructor({
    fetchImpl = globalThis.fetch,
    timeout = 30_000,
    retries = 2,
    metricsSettleAttempts = 12,
    metricsSettleIntervalMs = 200,
  } = {}) {
    if (!fetchImpl) {
      throw new Error("fetch is required");
    }
    this.fetch = fetchImpl;
    this.timeout = timeout;
    this.retries = retries;
    this.metricsSettleAttempts = metricsSettleAttempts;
    this.metricsSettleIntervalMs = metricsSettleIntervalMs;
  }

  async spawn(agent, task) {
    const session = await this.createSession(agent);
    const admitted = await this.sendPrompt(agent, session.id, task.prompt, task.roleContract);
    const serveUrl = agent.serveUrl;
    const sessionId = session.id;
    const cwd = agent.cwd;
    const completionMode = agent.completionMode ?? "snapshot-stable";
    return {
      backend: "opencode-serve",
      backendSessionId: sessionId,
      serveUrl,
      cwd,
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
      session: (...args) => this.session(...args),
      messages: (...args) => this.messages(...args),
      sessionStatus: (...args) => this.sessionStatus(...args),
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

  async sendPrompt(agent, sessionId, text, roleContract) {
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
    if (typeof roleContract === "string" && roleContract.length > 0) {
      body.system = roleContract;
    }
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
   * OpenCode's status endpoint is the authoritative active/idle projection.
   * Idle sessions are commonly omitted from the returned map.
   */
  async sessionStatus(serveUrl, sessionId, { cwd } = {}) {
    const url = new URL(`${trimSlash(serveUrl)}/session/status`);
    if (cwd) {
      url.searchParams.set("directory", cwd);
    }
    const statuses = await this.request(url, { method: "GET" });
    return statuses && typeof statuses === "object"
      ? statuses[sessionId] ?? null
      : null;
  }

  async trySessionStatus(serveUrl, sessionId, cwd) {
    try {
      return {
        observed: true,
        status: await this.sessionStatus(serveUrl, sessionId, { cwd }),
      };
    } catch {
      return { observed: false, status: null };
    }
  }

  /**
   * S1-1：尝试取 session token 并构造 metrics 事件（供周期性轮询用）。
   * 失败（endpoint 报错 / 无 token）返回 null，不阻断轮询。
   * 和完成判定路径里的 session token 提取逻辑一致，但独立为可复用方法。
   */
  async trySessionMetrics(serveUrl, sessionId, cwd) {
    const result = await this.readSessionMetrics(serveUrl, sessionId, cwd);
    return result.event;
  }

  async readSessionMetrics(serveUrl, sessionId, cwd) {
    try {
      const sess = await this.session(serveUrl, sessionId, { cwd });
      return {
        observed: true,
        terminal: !sess?.tokens,
        event: metricsEventFromSession(sess),
      };
    } catch {
      return { observed: false, terminal: true, event: null };
    }
  }

  /**
   * OpenCode may settle session usage shortly after abort. Poll a bounded
   * number of times and return only a nonzero snapshot that is stable twice.
   */
  async settleSessionMetrics(serveUrl, sessionId, cwd) {
    let latest = null;
    let latestKey = null;
    let stableReads = 0;
    for (let attempt = 0; attempt < this.metricsSettleAttempts; attempt += 1) {
      const result = await this.readSessionMetrics(serveUrl, sessionId, cwd);
      const event = result.event;
      if (event) {
        const key = JSON.stringify(event);
        latest = event;
        stableReads = key === latestKey ? stableReads + 1 : 1;
        latestKey = key;
        if (stableReads >= 2) return event;
      }
      if (!result.observed || result.terminal) return null;
      if (attempt < this.metricsSettleAttempts - 1) {
        await sleep(this.metricsSettleIntervalMs);
      }
    }
    return null;
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
    let busySeen = false;
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
      const hasAnyAssistantMessage = msgs.some((m) => m.info?.role === "assistant");
      if (!hasAnyAssistantMessage) {
        const statusResult = await this.trySessionStatus(serveUrl, sessionId, cwd);
        if (statusResult.observed) {
          const type = sessionStatusType(statusResult.status);
          if (type === "busy" || type === "retry") {
            busySeen = true;
          } else if (type === "idle" && busySeen) {
            yield doneEvent("failed", "session ended without assistant output");
            return;
          }
        }
      }
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
          // End the provider session before reading final usage. OpenCode 1.18
          // may settle session tokens shortly after abort, so a single read at
          // this point can produce a false zero.
          try {
            await this.abort(serveUrl, sessionId);
          } catch {
            // A completed answer remains usable; cleanup will retry abort.
          }
          const settledMetrics = await this.settleSessionMetrics(serveUrl, sessionId, cwd);
          if (settledMetrics) {
            yield settledMetrics;
          } else {
            const finalAssistant = msgs.findLast(
              (m) => m.info?.role === "assistant"
                && m.parts?.some((p) => p.type === "text" && p.text),
            );
            const messageMetrics = metricsEventFromMessage(finalAssistant);
            if (messageMetrics) yield messageMetrics;
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
    let busySeen = false;
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
      const hasAnyAssistant = msgs.some((m) => m.info?.role === "assistant");
      if (!hasAnyAssistant) {
        const statusResult = await this.trySessionStatus(serveUrl, sessionId, cwd);
        if (statusResult.observed) {
          const type = sessionStatusType(statusResult.status);
          if (type === "busy" || type === "retry") {
            busySeen = true;
          } else if (type === "idle" && busySeen) {
            yield doneEvent("failed", "session ended without assistant output");
            return;
          }
        }
      }
      // S1-1 修复：周期性 yield metrics（同 snapshot-stable），让预算闸门能在 first-stable
      // 等待首条 text 答案期间也检测到 token 增长。
      if (pollCount % METRICS_POLL_EVERY === 0) {
        const metricsEv = await this.trySessionMetrics(serveUrl, sessionId, cwd);
        if (metricsEv) yield metricsEv;
      }

      // 静默早失败：同 snapshot-stable。
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
        // DeepSeek-v4-flash can immediately start another round. Abort first,
        // then wait briefly for OpenCode's session-level usage to settle.
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
        const settledMetrics = await this.settleSessionMetrics(serveUrl, sessionId, cwd);
        if (settledMetrics) {
          yield settledMetrics;
        } else {
          const messageMetrics = metricsEventFromMessage(firstAssistantFinished);
          if (messageMetrics) yield messageMetrics;
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

function metricsEventFromSession(session) {
  const tokens = session?.tokens;
  if (!tokens || !hasNonzeroUsage(tokens, session?.cost)) return null;
  return metricsEvent({
    input: tokens.input,
    output: tokens.output,
    reasoning: tokens.reasoning,
    costUsd: typeof session.cost === "number" ? session.cost : undefined,
  });
}

function metricsEventFromMessage(message) {
  const tokens = message?.info?.tokens;
  const cost = message?.info?.cost;
  if (!tokens || !hasNonzeroUsage(tokens, cost)) return null;
  return metricsEvent({
    input: tokens.input,
    output: tokens.output,
    reasoning: tokens.reasoning,
    costUsd: typeof cost === "number" ? cost : undefined,
  });
}

function hasNonzeroUsage(tokens, cost) {
  return [tokens?.input, tokens?.output, tokens?.reasoning, cost]
    .some((value) => typeof value === "number" && value !== 0);
}

function sessionStatusType(status) {
  if (status === null || status === undefined) return "idle";
  if (typeof status === "string") return status;
  if (status && typeof status.type === "string") return status.type;
  return "unknown";
}

function isVersionAtLeast(value, minimum) {
  if (typeof value !== "string") return false;
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
  if (!match) return false;
  const actual = match.slice(1).map(Number);
  for (let i = 0; i < minimum.length; i += 1) {
    if (actual[i] > minimum[i]) return true;
    if (actual[i] < minimum[i]) return false;
  }
  return true;
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
