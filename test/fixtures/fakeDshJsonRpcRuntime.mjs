import readline from "node:readline";

const mode = process.env.FAKE_DSH_MODE ?? "success";
let sequence = 0;

function write(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function respond(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function notify(method, params) {
  write({ jsonrpc: "2.0", method, params });
}

function event(sessionId, type, data) {
  notify("session.event", {
    sessionId,
    event: { type, seq: sequence++, time: Date.now(), data },
  });
}

function assistant(sessionId, text, usage) {
  event(sessionId, "assistant/message", {
    turn: 1,
    step: 1,
    message: { role: "assistant", content: [{ type: "text", text }] },
    ...(usage ? { usage } : {}),
  });
}

function emitTurn(sessionId, messageId) {
  event(sessionId, "agent/inbox/spliced", {
    target: "next-turn",
    start: 0,
    inserted: [{
      id: messageId,
      role: "user",
      content: [],
      source: { kind: "user" },
    }],
  });
  notify("session.status", { sessionId, status: "running" });

  if (mode === "subagent") {
    notify("subagent.started", {
      parentSessionId: sessionId,
      childSessionId: "child-session",
    });
    return;
  }

  if (mode === "transport-close") {
    setImmediate(() => process.exit(0));
    return;
  }

  if (mode === "evidence") {
    event(sessionId, "tool/call", {
      turn: 1,
      step: 1,
      callId: "call-shell",
      name: "pwsh",
      arguments: JSON.stringify({ command: "Get-Content README.md" }),
    });
    event(sessionId, "tool/result", {
      turn: 1,
      step: 1,
      message: {
        role: "tool",
        content: [{ type: "text", text: "ok" }],
        source: { callId: "call-shell" },
      },
    });
    event(sessionId, "tool/call", {
      turn: 1,
      step: 1,
      callId: "call-edit",
      name: "str_replace_editor",
      arguments: JSON.stringify({ command: "str_replace", path: "src/example.js" }),
    });
    event(sessionId, "tool/result", {
      turn: 1,
      step: 1,
      message: {
        role: "tool",
        content: [{ type: "text", text: "edited" }],
        source: { callId: "call-edit" },
      },
    });
  }

  if (mode === "streaming") {
    event(sessionId, "assistant/chunk", {
      turn: 1,
      step: 1,
      chunk: { type: "text-delta", index: 0, text: "DSH" },
    });
    event(sessionId, "assistant/chunk", {
      turn: 1,
      step: 1,
      chunk: { type: "text-delta", index: 0, text: "_OK" },
    });
  }

  if (mode === "error") {
    event(sessionId, "turn/end", {
      turn: 1,
      reason: { kind: "error", error: { message: "provider secret detail", code: "SERVER" } },
    });
  } else {
    assistant(sessionId, `DSH_OK ${process.env.DSH_MODEL ?? "missing-model"}`, {
      input_tokens: 12,
      output_tokens: 4,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 2,
    });
    event(sessionId, "turn/end", { turn: 1, reason: { kind: "completed" } });
  }
  notify("session.status", { sessionId, status: "idle" });
}

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    process.exit(2);
  }
  if (frame.method === "initialize") {
    if (mode === "bad-identity") {
      respond(frame.id, { serverInfo: { name: "other-runtime", version: "0.0.0" } });
      return;
    }
    respond(frame.id, {
      serverInfo: { name: "deepseek-harness-sdk-runtime", version: "0.1.0-rc.6" },
    });
    return;
  }
  if (frame.method === "session/prompt") {
    const sessionId = frame.params.sessionId;
    const messageId = `message-${sequence}`;
    if (mode === "foreign-first") {
      assistant("foreign-session", "FOREIGN_OUTPUT");
    }
    // DSH may emit notifications before the request response. The client must
    // buffer them and bind completion to this durable message receipt.
    if (mode === "transport-close") {
      respond(frame.id, { messageId });
      emitTurn(sessionId, messageId);
      return;
    }
    emitTurn(sessionId, messageId);
    respond(frame.id, { messageId });
    return;
  }
  if (frame.method === "shutdown") {
    respond(frame.id, {});
    setImmediate(() => process.exit(0));
  }
});
