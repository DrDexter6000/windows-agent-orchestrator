// _cliTestHelpers.mjs
//
// cli.test.js 拆分（TD-138 全量提速批）共用的测试辅助。规则：只放被两个及以
// 上 CLI 测试文件使用的辅助；单文件专用的辅助留在各自文件里。三个消费方：
// test/isolation-infra/cli.test.js、cli-registry.test.js、cli-runs.test.js。

import assert from "node:assert/strict";
import { spawnSync, execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 捕获 console.log 输出（用于测命令渲染）。返回拼接的字符串。 */
export async function captureLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.map(String).join(" ")); };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines.join("\n");
}

// 用与套件相同的解释器执行 CLI 并返回 stdout。这些 registry list/validate 行为
// 测试的子进程验证的是 CLI 行为本身，不是 version guard（guard 的行为由
// test/nodeVersionGuard.test.js 专测）。TD-242（2026-10-09）：改用
// process.execPath（canonical 套件实际运行的 v22）钉住解释器——PATH 上的
// node 常是 v24 且其行为漂移会让本文件对机器环境过敏（历史"PATH 基线"红的
// 一半来由）；WAO_SKIP_VERSION_GUARD=1 保留，双保险。不写全局/用户 env。
export function runCliOnPathNode(cmd) {
  return execSync(`"${process.execPath}" src/cli.js ${cmd}`, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, WAO_SKIP_VERSION_GUARD: "1" },
  });
}

// TD-107：doctor 系列共用——dummy key 让 verdict 不被本机密钥缺失污染。
export function doctorSpawnEnv() {
  return {
    ...process.env,
    KIMI_WEB_TOKEN: process.env.KIMI_WEB_TOKEN || "td107-test-key",
    KIMI_API_KEY: process.env.KIMI_API_KEY || "td107-test-key",
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || "td107-test-key",
  };
}

export function makeDoctorPanelFixture(name, agents) {
  const dir = mkdtempSync(join(tmpdir(), name));
  spawnSync(process.execPath, ["src/cli.js", "wao", "init", "--cwd", dir],
    { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
  const registryPath = join(dir, "agents.json");
  writeFileSync(registryPath, JSON.stringify({ agents }, null, 2), "utf8");
  return { dir, registryPath };
}

export function doctorPanelRun(dir, registryPath) {
  return spawnSync(process.execPath, ["src/cli.js", "wao", "doctor",
    "--registry", registryPath, "--cwd", dir, "--format", "json"],
    { cwd: process.cwd(), encoding: "utf8",
      env: { ...doctorSpawnEnv(), HOME: dir, USERPROFILE: dir }, timeout: 20000 });
}

// R12 共用夹具：fake backend 捕获 spawn 的合成 policy；registry agent 带齐
// model+reasoning 静态策略（含兄弟字段，验证"只替换 .id/.effort"）。
// R13-C 诚实修正：自称 claude-code 的假 backend 不得返回 messageId/admittedSeq——
// 真实 claudeCode/kimiCode/codex 都 extends ProcessBackend，其 spawn 结果带
// messageId: undefined（processBackend.js:340），transcript.append 的
// JSON.stringify 丢 undefined 键 → 该家族的合法 TD-54 双写【两条都无
// messageId】。旧夹具返回 messageId 掩盖了"messageId 优先收窄对该家族是死
// 代码"的空档（auditor 探针 D）。
export function makeRetryInheritFixture(dir) {
  const spawned = [];
  const fakeBackend = {
    validateAgentPolicy(agent) {
      assert.ok(agent.model && typeof agent.model.id === "string",
        "synthesized model reaches the ordinary policy validation surface");
    },
    async spawn(agent) {
      spawned.push({ model: agent.model, reasoning: agent.reasoning });
      return {
        backend: "claude-code",
        backendSessionId: "s_r12",
        async *events() {
          yield { kind: "assistant", role: "assistant", parts: [{ type: "text", text: "done" }] };
          yield { kind: "done", reason: "completed" };
        },
        abort: async () => {},
        isAlive: () => false,
      };
    },
  };
  const readRegistry = async () => ({
    getAgent(id, overrides = {}) {
      return {
        id, backend: "claude-code", cwd: dir,
        model: { id: "glm-5.3", contextWindow: 1000000 },
        reasoning: { effort: "medium" },
        ...overrides,
      };
    },
    listAgents() { return []; },
  });
  const config = {
    registry: "x", runDir: dir, pollInterval: 10, waitTimeout: 5000,
    timeout: 5000, retries: 0, backendFor: () => fakeBackend, readRegistry,
  };
  return { config, spawned };
}

/**
 * 解析 retry 输出的单个 pretty-printed JSON 对象。
 * 使用它的测试文件 import 了 src/cli.js——其自执行 main() 的异步 printHelp()
 * 可能落进首个执行测试的捕获窗口（既有套件级怪癖，对不做整体 JSON.parse 的
 * 测试无害）。
 * retryCommand 恰打印一个 JSON 对象且 HELP_TEXT 不含花括号，故从首个 "{" 切到
 * 末个 "}" 即可确定性还原（容忍前后污染）。
 */
export function parseRetryJson(out) {
  const start = out.indexOf("{");
  const end = out.lastIndexOf("}");
  assert.ok(start !== -1 && end > start, `retry JSON 输出应在捕获中（got: ${out.slice(0, 80)}…）`);
  return JSON.parse(out.slice(start, end + 1));
}

/** 落盘一个源 run transcript（run.started [+ 覆盖事实] + prompt.sent）。
 * R12-C C-1：事件信封带 runId——与真实 JsonlTranscript.append 同构（它给每条
 * 事件盖 runId 戳；readTranscript 只逐行 JSON.parse，不补信封）。omitStarted
 * 落盘"缺 run.started"的旧格式（R10 前）；extraEvents 追加在尾部（篡改探针：
 * 伪造 run.started 追加进同一 transcript 文件）。 */
export function writeRetrySource(dir, runId, { modelOverride, reasoningOverride, omitStarted = false, extraEvents = [] } = {}) {
  const started = {
    seq: 1, ts: "2026-08-18T00:00:00.000Z", type: "run.started", runId, agentId: "claude_worker",
    backend: "claude-code", cwd: dir,
    model: { id: "glm-5.3", contextWindow: 1000000 },
    reasoning: { effort: "medium" },
    ...(modelOverride !== undefined ? { modelOverride } : {}),
    ...(reasoningOverride !== undefined ? { reasoningOverride } : {}),
  };
  const prompt = {
    seq: 2, ts: "2026-08-18T00:00:00.100Z", type: "prompt.sent", runId, agentId: "claude_worker",
    prompt: "original task prompt",
  };
  const events = [...(omitStarted ? [] : [started]), prompt, ...extraEvents];
  writeFileSync(join(dir, `${runId}.jsonl`), `${events.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
}
