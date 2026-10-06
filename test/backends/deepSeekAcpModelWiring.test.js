// test/backends/deepSeekAcpModelWiring.test.js
//
// 0046 §3/§5 第④步：deepseek-acp model 块接线（session/set_config_option
// configId="model"）的确定性单测。
//
// wire 事实全部锚定 scripts/reliability/dsh-acp/evidence/phase5-config-option-set.json：
//   - value 形状 = JSON 字符串化的 [provider, model] 二元组，provider 段实测
//     "deepseek-official"（测试里写字面量精确串钉住，不用同一表达式自证）；
//   - **设 model 会把 reasoning_effort 重置回 high**（steps.setModel 响应里
//     effort currentValue 回到 "high"，即使前序 setEffortAgain 已设 max）；
//   - 广告选项漂移：切走后原值从选项列表消失——值域权威 = session/new 时刻快照。
//
// 夹具纪律与 deepSeekAcp.test.js 同源（fake child + fake ACP peer；零真实 dsh、
// 零模型调用、零网络），但 peer 为 model 场景目的构建：session/new 携带证据形状
// 的分组 configOptions，set_config_option 按 configId 分派并维护 model/effort
// 状态（含事实 2 的 effort 重置模拟）。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

import { DeepSeekAcpBackend } from "../../src/backends/deepSeekAcp.js";

const REFERENCE_CONTAINMENT = readFileSync(
  new URL("../../scripts/reliability/dsh-acp/wao-contain-safe.patch.yml", import.meta.url),
  "utf8",
);

// 证据文件 snapshot.model 里的三个广告值——字面量精确串（钉 wire 形状，防用
// JSON.stringify 同表达式自证循环）。
const V4_FLASH = '["deepseek-official","deepseek-v4-flash"]';
const FLASH = '["deepseek-official","deepseek-flash"]';
const V4_PRO = '["deepseek-official","deepseek-v4-pro"]';

function agent(overrides = {}) {
  return {
    id: "coder_low_dsh",
    backend: "deepseek-acp",
    cwd: process.cwd(),
    // 绝对路径跳过 where.exe 探测；spawn 本身被 stub。
    binary: "D:/wao-test/dsh-acp-stub.exe",
    credentialEnv: "DEEPSEEK_API_KEY",
    ...overrides,
  };
}

/** fake 子进程：PassThrough 三流 + spawn 即成功 + kill/end 即 close。 */
function makeFakeChild() {
  const child = new EventEmitter();
  child.pid = 424242;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  const originalOnce = child.once.bind(child);
  child.once = (event, listener) => {
    originalOnce(event, listener);
    if (event === "spawn") queueMicrotask(() => listener());
    return child;
  };
  child.end = (code = 0) => {
    if (child.exitCode !== null) return;
    child.exitCode = code;
    child.emit("close", code, null);
  };
  child.kill = () => {
    child.end(1);
    return true;
  };
  return child;
}

/** 证据形状的 model 选项（分组 select，phase5 steps.sessionNew.configOptions）。 */
function modelOption({ currentValue = V4_FLASH, values = [V4_FLASH, FLASH, V4_PRO] } = {}) {
  return {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue,
    options: [{
      group: "deepseek-official",
      name: "DeepSeek",
      options: values.map((value) => ({ value, name: value })),
    }],
  };
}

function effortOption(currentValue = "high") {
  return {
    id: "reasoning_effort",
    name: "Reasoning effort",
    category: "thought_level",
    type: "select",
    currentValue,
    options: [
      { value: "off", name: "Off" },
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
      { value: "max", name: "Max" },
    ],
  };
}

/**
 * model 场景 peer。session/new 响应携带证据形状 configOptions（可注入漂移/缺席）；
 * set_config_option 按 configId 分派：
 *   - model set：上报 currentValue（可伪确认），并把 effort 重置回 high（事实 2，
 *     可注入观察值）；响应同时携带两选项（证据形状）。
 *   - effort set：上报 currentValue（可伪确认）；model 选项携带状态值（可注入
 *     漂移值，钉双读回确认）。
 * omitConfigOption 按 configId 精确缺席；error 注入 JSON-RPC 错误。
 */
function fakeModelAcpPeer(child, {
  sessionId = "sess-acp-model-1",
  agentName = "deepseek-harness-acp",
  // session/new 应答策略：{ omitConfigOptions }（响应不带 configOptions）/
  // { omitModelOption }（带 configOptions 但无 model 选项）/ { modelValues } /
  // { modelCurrentValue }。
  newSessionMode = null,
  // session/resume 应答策略：{ error } / { echoDifferentSessionId } /
  // { modelValue } / { effortValue } / { omitModelOption }。
  resumeMode = null,
  // set_config_option 应答策略：{ error } / { modelConfirmValue } /
  // { effortConfirmValue } / { effortAfterModelSet } / { effortResponseModelValue } /
  // { omitConfigOption: "model" | "reasoning_effort" }。
  setMode = null,
} = {}) {
  const clientRequests = [];
  const setResponses = [];
  const state = { model: V4_FLASH, effort: "high" };
  const send = (obj) => child.stdout.write(JSON.stringify(obj) + "\n");
  const lines = readline.createInterface({ input: child.stdin });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    if (!message.method) return;
    clientRequests.push(message);
    if (message.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: agentName, version: "0.0.1" },
          sessionCapabilities: { close: {}, list: {}, resume: {} },
        },
      });
    } else if (message.method === "session/new") {
      if (newSessionMode?.omitConfigOptions) {
        send({ jsonrpc: "2.0", id: message.id, result: { sessionId } });
        return;
      }
      const options = [
        effortOption("high"),
        ...(newSessionMode?.omitModelOption ? [] : [modelOption({
          currentValue: newSessionMode?.modelCurrentValue ?? state.model,
          values: newSessionMode?.modelValues,
        })]),
      ];
      send({ jsonrpc: "2.0", id: message.id, result: { sessionId, configOptions: options } });
    } else if (message.method === "session/resume") {
      if (resumeMode?.error) {
        send({ jsonrpc: "2.0", id: message.id, error: resumeMode.error });
        return;
      }
      const options = [
        effortOption(resumeMode?.effortValue ?? "high"),
        ...(resumeMode?.omitModelOption ? [] : [modelOption({
          currentValue: resumeMode?.modelValue ?? state.model,
        })]),
      ];
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          ...(resumeMode?.echoDifferentSessionId ? { sessionId: "sess-acp-OTHER" } : {}),
          configOptions: options,
        },
      });
    } else if (message.method === "session/set_config_option") {
      const configId = message.params?.configId;
      if (setMode?.error) {
        send({ jsonrpc: "2.0", id: message.id, error: setMode.error });
        return;
      }
      const options = [];
      if (configId === "model") {
        const reported = setMode?.modelConfirmValue ?? message.params?.value;
        state.model = reported;
        // 事实 2：设 model 重置 effort 回 high（默认），可注入别的观察值。
        state.effort = setMode?.effortAfterModelSet ?? "high";
        if (setMode?.omitConfigOption !== "model") options.push(modelOption({ currentValue: reported }));
        options.push(effortOption(state.effort));
      } else if (configId === "reasoning_effort") {
        const reported = setMode?.effortConfirmValue ?? message.params?.value;
        state.effort = reported;
        options.push(modelOption({ currentValue: setMode?.effortResponseModelValue ?? state.model }));
        if (setMode?.omitConfigOption !== "reasoning_effort") options.push(effortOption(reported));
      }
      const result = { configOptions: options };
      setResponses.push({ configId, params: message.params, result });
      send({ jsonrpc: "2.0", id: message.id, result });
    } else if (message.method === "session/close") {
      send({ jsonrpc: "2.0", id: message.id, result: {} });
      child.end(0);
    } else if (message.method === "session/cancel") {
      send({ jsonrpc: "2.0", id: message.id, result: {} });
    }
  });
  return {
    clientRequests,
    setResponses,
    sessionId,
    respond(id, result) { send({ jsonrpc: "2.0", id, result }); },
  };
}

function makeBackend(child, dir) {
  const containmentPath = join(dir, "wao-contain.patch.yml");
  writeFileSync(containmentPath, REFERENCE_CONTAINMENT, "utf8");
  return new DeepSeekAcpBackend({ containmentPatchPath: containmentPath, spawnFn: () => child });
}

const FIRST_TURN = { prompt: "do the task" };
const RESUME_TURN = {
  prompt: "follow up",
  sessionReuse: { mode: "lead_workspace", turn: "resume", opaqueUuid: "0f1e2d3c-4b5a-4978-8976-a5b4c3d2e1f0", priorRunId: "run_prior_1" },
  priorProviderSessionId: "75c13e12-ce24-4409-b88e-59669cc70712",
};

/** 等待谓词为真（有界轮询，同 deepSeekAcp.test.js 的 waitUntil 纪律）。 */
async function waitUntil(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(10);
  }
  return Boolean(predicate());
}

/** 成功场景：spawn → drive（缺省等待 prompt 请求出现并应答 end_turn）→ 收全事件。 */
async function runModelScenario({ agentOverrides = {}, peerOptions = {}, task = FIRST_TURN, drive } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wao-acp-model-test-"));
  try {
    const child = makeFakeChild();
    const backend = makeBackend(child, dir);
    const peer = fakeModelAcpPeer(child, peerOptions);
    const handle = await backend.spawn(agent(agentOverrides), task);
    const promptRequest = () => peer.clientRequests.find((m) => m.method === "session/prompt");
    if (drive) {
      await drive({ peer, child, handle, promptRequest });
    } else {
      const found = await waitUntil(() => promptRequest() !== undefined);
      assert.ok(found, "prompt request must appear after the config-option sets");
      peer.respond(promptRequest().id, { stopReason: "end_turn" });
    }
    const events = [];
    for await (const event of handle.events(new AbortController().signal)) events.push(event);
    return { events, peer, child, handle };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 拒绝场景：spawn 应 reject，返回错误与已发出的 wire 请求（供零 prompt 断言）。 */
async function runModelReject({ agentOverrides = {}, peerOptions = {}, task = FIRST_TURN }) {
  const dir = mkdtempSync(join(tmpdir(), "wao-acp-model-reject-"));
  try {
    const child = makeFakeChild();
    const backend = makeBackend(child, dir);
    const peer = fakeModelAcpPeer(child, peerOptions);
    const error = await backend.spawn(agent(agentOverrides), task).then(() => null, (e) => e);
    return { error, peer, child };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const MODEL_SETS = (peer) => peer.clientRequests
  .filter((m) => m.method === "session/set_config_option" && m.params?.configId === "model");
const EFFORT_SETS = (peer) => peer.clientRequests
  .filter((m) => m.method === "session/set_config_option" && m.params?.configId === "reasoning_effort");
const PROMPTS = (peer) => peer.clientRequests.filter((m) => m.method === "session/prompt");

// ===== ① 策略形状（策略层快钉；与 deepSeekAcp.test.js 改写用例互为独立证人）=====

test("0046 model 接线 ①：{ id, providerID } 双字段策略通过；裸 id / 缺 id / 多余子字段固定文案拒", () => {
  const backend = new DeepSeekAcpBackend();
  assert.doesNotThrow(() => backend.validateAgentPolicy(agent({
    model: { id: "deepseek-v4-flash", providerID: "deepseek-official" },
  })));
  for (const bad of [
    { id: "deepseek-v4-flash" },                                    // 裸 id：无 providerID
    { providerID: "deepseek-official" },                            // 缺 id
    { id: "", providerID: "deepseek-official" },                    // 空 id
    { id: "deepseek-v4-flash", providerID: "" },                    // 空 providerID
    { id: "deepseek-v4-flash", contextWindow: 1000000 },            // canonical 形状混入
    "deepseek-v4-flash",                                            // 非对象
  ]) {
    assert.throws(
      () => backend.validateAgentPolicy(agent({ model: bad })),
      /requires both model\.id and model\.providerID as non-empty strings/,
      JSON.stringify(bad),
    );
  }
  assert.throws(
    () => backend.validateAgentPolicy(agent({
      model: { id: "deepseek-v4-flash", providerID: "deepseek-official", variant: "x" },
    })),
    /model policy only accepts \{ id, providerID \}/,
  );
  // 空值视同未配置。
  assert.doesNotThrow(() => backend.validateAgentPolicy(agent({ model: null })));
});

// ===== ② wire 值形状 =====

test("0046 model 接线 ②：wire value 是 JSON 字符串化的 [provider, model] 数组（对 mock transport 断言精确字符串）", async () => {
  const { events, peer } = await runModelScenario({
    agentOverrides: { model: { id: "deepseek-flash", providerID: "deepseek-official" } },
  });
  const sets = MODEL_SETS(peer);
  assert.equal(sets.length, 1, "恰一次 model set（未配 effort，不发 effort set）");
  assert.equal(EFFORT_SETS(peer).length, 0, "未配置 effort 不得发 effort set");
  // 精确字符串钉（字面量，防同表达式自证）：JSON.stringify(["deepseek-official","deepseek-flash"])。
  assert.equal(sets[0].params.value, '["deepseek-official","deepseek-flash"]');
  assert.equal(typeof sets[0].params.value, "string", "wire value 必须是字符串（JSON 数组的序列化形）");
  assert.deepEqual(sets[0].params, {
    sessionId: peer.sessionId,
    configId: "model",
    value: '["deepseek-official","deepseek-flash"]',
  });
  assert.ok(sets[0].id < PROMPTS(peer)[0].id, "model set 必须先于 prompt");
  const audit = events.find((e) => e.kind === "message" && e.role === "system"
    && e.parts.some((p) => /deepseek-acp model set/.test(p.text ?? "")));
  assert.ok(audit, "model 设置必须有 system 转录事实");
  assert.equal(events.at(-1).reason, "completed");
});

// ===== ③ 先 model 后 effort 顺序 + 双读回确认 =====

test("0046 model 接线 ③：先 model 后 effort（请求序 model < effort < prompt）+ 最后一次响应双读回确认", async () => {
  const { events, peer } = await runModelScenario({
    agentOverrides: {
      model: { id: "deepseek-flash", providerID: "deepseek-official" },
      reasoning: { effort: "max" },
    },
  });
  const modelSet = MODEL_SETS(peer);
  const effortSet = EFFORT_SETS(peer);
  assert.equal(modelSet.length, 1);
  assert.equal(effortSet.length, 1);
  assert.ok(modelSet[0].id < effortSet[0].id, "model set 必须先于 effort set（effort 重放盖掉重置）");
  assert.ok(effortSet[0].id < PROMPTS(peer)[0].id, "effort set 必须先于 prompt");
  assert.equal(effortSet[0].params.value, "max");
  // 双读回确认的证词面：model set 审计 + effort set 审计都在 transcript。
  const modelAudit = events.filter((e) => e.kind === "message" && e.role === "system"
    && e.parts.some((p) => /deepseek-acp model set/.test(p.text ?? "")));
  const effortAudit = events.filter((e) => e.kind === "message" && e.role === "system"
    && e.parts.some((p) => /deepseek-acp reasoning effort set/.test(p.text ?? "")));
  assert.equal(modelAudit.length, 1);
  assert.equal(effortAudit.length, 1);
  assert.match(effortAudit[0].parts[0].text, /requested=max, confirmed=max/);
  assert.equal(events.at(-1).reason, "completed");
});

// ===== ④ setModel 重置 effort：必须重放 effort =====

test("0046 model 接线 ④：model set 响应携带 effort=high（重置事实）→ 必须在其后重放 effort 设置", async () => {
  const { events, peer } = await runModelScenario({
    agentOverrides: {
      model: { id: "deepseek-flash", providerID: "deepseek-official" },
      reasoning: { effort: "max" },
    },
  });
  // 夹具先证事实 2 被观察到：model set 的响应里 effort currentValue = "high"。
  const modelResponse = peer.setResponses.find((r) => r.configId === "model");
  assert.ok(modelResponse, "必须发生 model set");
  const effortInModelResponse = modelResponse.result.configOptions
    .find((o) => o.id === "reasoning_effort");
  assert.equal(effortInModelResponse.currentValue, "high",
    "夹具钉：model set 响应里的 effort 已被重置回 high（证据形状）");
  // 尽管观察到了 high，backend 仍必须在 model 之后重放 effort=max（而非信任重置值）。
  const modelSet = MODEL_SETS(peer);
  const effortSet = EFFORT_SETS(peer);
  assert.equal(modelSet.length, 1);
  assert.equal(effortSet.length, 1, "effort 设置必须被重放");
  assert.ok(modelSet[0].id < effortSet[0].id);
  assert.equal(effortSet[0].params.value, "max");
  const effortAudit = events.find((e) => e.kind === "message" && e.role === "system"
    && e.parts.some((p) => /deepseek-acp reasoning effort set/.test(p.text ?? "")));
  assert.match(effortAudit.parts[0].text, /requested=max, confirmed=max/);
  assert.equal(events.at(-1).reason, "completed");
});

// ===== ⑤ resume：model 不匹配拒绝（不静默切换）=====

test("0046 model 接线 ⑤：resume 轮只读核对原 model——匹配即过（零 set），不匹配/缺选项即拒（零 prompt）", async () => {
  // 匹配：不发任何 set_config_option，转录留 model verified 事实。
  const ok = await runModelScenario({
    agentOverrides: { model: { id: "deepseek-v4-flash", providerID: "deepseek-official" } },
    task: RESUME_TURN,
  });
  assert.equal(MODEL_SETS(ok.peer).length + EFFORT_SETS(ok.peer).length, 0,
    "resume 轮绝不发 set（resumed 会话上的 set 无实证）");
  assert.ok(ok.events.some((e) => e.kind === "message" && e.role === "system"
    && e.parts.some((p) => /deepseek-acp model verified on the resumed session/.test(p.text ?? ""))));
  assert.equal(ok.events.at(-1).reason, "completed");

  // 不匹配：恢复的会话在 flash 上，配置是 v4-flash → 拒绝，绝不静默换模型。
  const mismatch = await runModelReject({
    agentOverrides: { model: { id: "deepseek-v4-flash", providerID: "deepseek-official" } },
    peerOptions: { resumeMode: { modelValue: FLASH } },
    task: RESUME_TURN,
  });
  assert.match(mismatch.error.message, /resumed session's model does not match the configured model/);
  assert.equal(PROMPTS(mismatch.peer).length, 0, "拒绝后绝不 prompt");
  assert.ok(!mismatch.peer.clientRequests.some((m) => m.method === "session/new"), "resume 轮绝不 session/new");
  assert.ok(!mismatch.error.message.includes("deepseek-v4-flash"), "拒绝文案不回显请求值（注入纪律）");

  // resume 响应缺 model 选项 → 无法核对 → 同款拒绝。
  const absent = await runModelReject({
    agentOverrides: { model: { id: "deepseek-v4-flash", providerID: "deepseek-official" } },
    peerOptions: { resumeMode: { omitModelOption: true } },
    task: RESUME_TURN,
  });
  assert.match(absent.error.message, /resumed session's model does not match the configured model/);
  assert.match(absent.error.message, /no model option/);
  assert.equal(PROMPTS(absent.peer).length, 0);
});

// ===== ⑥ 广告选项不含目标值 → 拒绝（值域权威 = session/new 时刻快照）=====

test("0046 model 接线 ⑥：session/new 广告快照不含目标 provider/model → 拒绝派发（零 wire set、零 prompt、不回显请求值）", async () => {
  // 未知 model id：广告只有 v4-flash / v4-pro，配置 flash。
  const unknownModel = await runModelReject({
    agentOverrides: { model: { id: "deepseek-flash", providerID: "deepseek-official" } },
    peerOptions: { newSessionMode: { modelValues: [V4_FLASH, V4_PRO] } },
  });
  assert.match(unknownModel.error.message,
    /not among the model options this session advertised at session\/new/);
  assert.equal(MODEL_SETS(unknownModel.peer).length, 0, "值域校验先于 wire：绝不发出 set");
  assert.equal(PROMPTS(unknownModel.peer).length, 0);
  assert.ok(!unknownModel.error.message.includes("deepseek-flash"), "不回显请求 model id");
  assert.ok(!unknownModel.error.message.includes("deepseek-official"), "不回显请求 provider 段");

  // 未知 provider 段：广告全部是 deepseek-official 分组。
  const unknownProvider = await runModelReject({
    agentOverrides: { model: { id: "deepseek-v4-flash", providerID: "someone-else" } },
  });
  assert.match(unknownProvider.error.message, /not among the model options this session advertised at session\/new/);
  assert.ok(!unknownProvider.error.message.includes("someone-else"), "不回显请求 provider 段");
  assert.equal(MODEL_SETS(unknownProvider.peer).length, 0);

  // session/new 响应不带 configOptions（快照缺席）→ 无法建立值域权威 → 同款拒绝。
  const noSnapshot = await runModelReject({
    agentOverrides: { model: { id: "deepseek-v4-flash", providerID: "deepseek-official" } },
    peerOptions: { newSessionMode: { omitConfigOptions: true } },
  });
  assert.match(noSnapshot.error.message,
    /not among the model options this session advertised at session\/new/);
  assert.equal(PROMPTS(noSnapshot.peer).length, 0);
});

// ===== fail-closed 确认纪律（零 prompt）=====

test("0046 model 接线 fail-closed：set 响应未确认 / 缺 model 选项 / JSON-RPC 错误 / effort 响应里 model 漂移 → 拒绝且不发 prompt", async () => {
  const cases = [
    {
      name: "model set 伪确认（currentValue 与请求不符）",
      peerOptions: { setMode: { modelConfirmValue: V4_FLASH } }, // 请求 flash，上报 v4-flash
      pattern: /session\/set_config_option did not confirm the requested model .*got a different value/,
    },
    {
      name: "model set 响应不含 model 选项",
      peerOptions: { setMode: { omitConfigOption: "model" } },
      pattern: /session\/set_config_option did not confirm the requested model .*got no model option/,
    },
    {
      name: "model set JSON-RPC 错误（如 -32602）",
      peerOptions: { setMode: { error: { code: -32602, message: "Invalid params: unknown model" } } },
      pattern: /JSON-RPC error -32602/,
    },
    {
      name: "effort set 响应里 model currentValue 漂移（双读回确认第二条腿）",
      peerOptions: { setMode: { effortResponseModelValue: V4_FLASH } }, // 已确认 flash，effort 响应报 v4-flash
      pattern: /reasoning_effort\) response did not hold the already-confirmed model/,
    },
  ];
  for (const c of cases) {
    const outcome = await runModelReject({
      agentOverrides: {
        model: { id: "deepseek-flash", providerID: "deepseek-official" },
        reasoning: { effort: "max" },
      },
      peerOptions: c.peerOptions,
    });
    assert.ok(outcome.error, c.name);
    assert.match(outcome.error.message, c.pattern, c.name);
    assert.equal(PROMPTS(outcome.peer).length, 0, c.name + "：不得发出 session/prompt");
  }
});
