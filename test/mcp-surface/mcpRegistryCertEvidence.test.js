// test/mcp-surface/mcpRegistryCertEvidence.test.js
//
// ADR-0032 修订（2026-09-22，Owner 裁定）：认证证据详情按需投影到 MCP
// registry_list 只读面——MCP 层保真测试（不是服务层测试的重复）。
//
// 与 test/registry-roles/certificationEvidenceInventory.test.js（服务层）的
// 分工：服务层钉 getCertificationEvidenceInventory 的判定；本文件钉
// **经 MCP 投影后**以下事实仍分别可辨（硬验收：投影不得丢语义）：
//   - 适用性三态 matched / mismatched / undeterminable（"无法判断"绝不算绿）；
//   - 两本台账（reliability-summary.json / component-checks.json）的来源状态
//     ok / missing / unparseable / read-error 各自独立可辨（不折叠、不吞）；
//   - 五列齐全（声明/组件观测/组合结果/适用性/限制与来源）——"限制与来源"
//     未为控体积丢弃；
//   - 绝不派生"总体可用=true"式合并绿；组件通过不推出组合绿；
//   - 默认调用（不带 detail）输出键集合一字不变（agents/issues/
//     issuesTruncated，无 certificationEvidence 键）；
//   - 输入闭集：detail 只接受 "certificationEvidence"；证据服务抛错/形状
//     违约整次 fail-closed（绝不静默省略被读成"无证据行"）。
//   - audit11（2026-09-23）：未预标注的自然过期（组件自身时间/夹具资格）经
//     wire 仍是限制项；lastFullHealthyRunAt 缺席渲染 lastFullHealthy=?。
//
// 纯内存传输（InMemoryTransport）+ os.tmpdir() 真实磁盘 fixture + 真实服务
// （默认 getCertificationEvidenceInventory，与 CLI 同一判断）——read-error
// 用"目录占位文件路径"（EISDIR，跨平台非 ENOENT）同样走真实服务；无进程
// spawn、无网络、无 token。门禁零改动（--require-certified / matchedCertRecord
// / requireCertified=false）由既有守卫文件承载，本文件不触。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWaoMcpServer } from "../../src/mcp/server.js";
import { TOOLS } from "../../src/mcp/toolSurface.js";

// ===== Helpers =====

function makeRegistry(dir, agents) {
  const registryPath = join(dir, "agents.json");
  writeFileSync(registryPath, JSON.stringify({ agents }), "utf8");
  return registryPath;
}

function makeRunDir(dir, variant = "") {
  const runDir = join(dir, "runs" + variant);
  mkdirSync(runDir, { recursive: true });
  return runDir;
}

function writeSummary(runDir, workers) {
  writeFileSync(join(runDir, "reliability-summary.json"), JSON.stringify({ workers }), "utf8");
}

function writeComponentLedger(runDir, components) {
  writeFileSync(join(runDir, "component-checks.json"), JSON.stringify({ components }), "utf8");
}

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

async function buildInMemoryClient(server) {
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const client = new Client({ name: "wao-adr32-mcp", version: "0.0.1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function callRegistryList(client, args = {}) {
  const res = await client.callTool({ name: "registry_list", arguments: args });
  const textBlock = res.content.find((b) => b.type === "text");
  return { res, parsed: JSON.parse(textBlock.text) };
}

// 与声明匹配的 worker 证据记录（服务层测试同形；画像身份四元组完整）。
function matchedWorkerRecord(overrides = {}) {
  return {
    status: "certified",
    backend: "codex",
    modelId: "gpt-6-astra",
    providerID: null,
    providerKey: null,
    lastHealthyRunAt: "2026-09-22T15:05:15.876Z",
    lastFullHealthyRunAt: "2026-09-22T15:05:15.876Z",
    executionProfile: {
      modelId: "gpt-6-astra",
      providerID: null,
      providerKey: null,
      effort: "high",
      codeRef: "92209bbdeadbeef",
      capturedAt: "2026-09-22T15:05:15.876Z",
    },
    ...overrides,
  };
}

function componentRecord(overrides = {}) {
  return {
    key: "backend:codex@92209bb",
    kind: "backend",
    result: "pass",
    lastVerifiedAt: "2026-09-21T10:00:00.000Z",
    codeRef: "92209bb",
    runtimeIdentity: { fingerprint: "v1-abc123def4567890", verified: true },
    ...overrides,
  };
}

// 声明侧席位（effort 可覆盖以制造 mismatched）。
function agentEntry(dir, effort) {
  return {
    backend: "codex",
    cwd: dir,
    model: { id: "gpt-6-astra" },
    reasoning: { effort },
  };
}

const NO_MERGED_GREEN_RE = /"(?:available|usable|overall|green|dispatchable)":\s*true/;

// =====================================================================
// 1. 默认调用一字不变：键集合恰为 agents/issues/issuesTruncated；
//    磁盘上证据齐全也不得泄入默认简表；证据服务零调用。
// =====================================================================

test("ADR32-MCP-1: default call keeps the exact prior key set; evidence service not called", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-adr32-m1-"));
  let evidenceCalls = 0;
  try {
    const registryPath = makeRegistry(dir, { auditor: agentEntry(dir, "high") });
    const runDir = makeRunDir(dir);
    writeSummary(runDir, { auditor: matchedWorkerRecord() });
    writeComponentLedger(runDir, { "backend:codex@92209bb": componentRecord() });

    const server = createWaoMcpServer({
      registryPath, runDir,
      getCertificationEvidenceFn: async () => { evidenceCalls += 1; return []; },
    });
    const client = await buildInMemoryClient(server);
    try {
      const { res, parsed } = await callRegistryList(client);
      assert.equal(res.isError, undefined, "default call succeeds");
      assert.deepEqual(
        Object.keys(parsed).sort(),
        ["agents", "issues", "issuesTruncated"],
        "default payload keys are exactly the prior shape (no certificationEvidence)",
      );
      assert.equal("certificationEvidence" in parsed, false, "no evidence key even with ledgers present");
      assert.deepEqual(res.structuredContent, parsed, "structuredContent equals text JSON");
      assert.equal(evidenceCalls, 0, "evidence service NOT called without detail");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// 2. 显式 detail:"certificationEvidence"：五列齐全 + 两账来源状态字段；
//    键集合闭集；structuredContent 与 text JSON 同一载荷。
// =====================================================================

test("ADR32-MCP-2: detail call returns per-seat five-column rows through the MCP wire", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-adr32-m2-"));
  try {
    const registryPath = makeRegistry(dir, { auditor: agentEntry(dir, "high") });
    const runDir = makeRunDir(dir);
    writeSummary(runDir, { auditor: matchedWorkerRecord() });
    writeComponentLedger(runDir, { "backend:codex@92209bb": componentRecord() });

    const server = createWaoMcpServer({ registryPath, runDir });
    const client = await buildInMemoryClient(server);
    try {
      const { res, parsed } = await callRegistryList(client, { detail: "certificationEvidence" });
      assert.equal(res.isError, undefined, "detail call succeeds");
      assert.deepEqual(
        Object.keys(parsed).sort(),
        ["agents", "certificationEvidence", "issues", "issuesTruncated"],
        "detail adds exactly one key",
      );
      assert.deepEqual(res.structuredContent, parsed, "structuredContent equals text JSON (schema-validated)");
      assert.equal(parsed.certificationEvidence.length, 1, "one row per registered seat");
      const row = parsed.certificationEvidence[0];
      assert.equal(row.id, "auditor");
      assert.deepEqual(
        Object.keys(row).sort(),
        [
          "applicability", "combined", "componentLedgerState", "componentObserved",
          "declared", "id", "limitations", "summaryLedgerState",
        ],
        "row shape is the closed five-column set (no extra/merged-green fields)",
      );
      // 五列各自承载事实（列内容非空、可读）。
      assert.match(row.declared, /backend=codex model=gpt-6-astra/);
      assert.match(row.declared, /effort=high/);
      assert.match(row.componentObserved, /state=ok/);
      assert.match(row.componentObserved, /pass@92209bb/);
      // B2（2026-09-22）：保留取证时间——组件观测行携带 lastVerifiedAt（此前紧凑
      // 渲染丢弃；与 CLI 文本渲染同形 result@codeRef@lastVerifiedAt#fingerprint）。
      assert.match(row.componentObserved, /pass@92209bb@2026-09-21T10:00:00\.000Z#/,
        "component forensic timestamp survives the wire projection");
      assert.match(row.combined, /status=certified/);
      assert.ok(Array.isArray(row.limitations), "limitations column present (never dropped for size)");
      assert.equal(row.summaryLedgerState, "ok");
      assert.equal(row.componentLedgerState, "ok");
      assert.ok(!NO_MERGED_GREEN_RE.test(JSON.stringify(parsed)), "no derived overall-usable boolean");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// 3. 三态分别可辨（matched / mismatched / undeterminable 同一 payload）；
//    undeterminable 绝不算绿；组件通过不推出组合绿（钉①）。
// =====================================================================

test("ADR32-MCP-3: applicability three states remain distinguishable through MCP; no merged green", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-adr32-m3-"));
  try {
    const registryPath = makeRegistry(dir, {
      seat_matched: agentEntry(dir, "high"),       // 记录全等 → matched
      seat_mismatch: agentEntry(dir, "medium"),    // 声明 effort 不同 → mismatched
      seat_undet: agentEntry(dir, "high"),         // 无该席位记录 → undeterminable
    });
    const runDir = makeRunDir(dir);
    writeSummary(runDir, {
      seat_matched: matchedWorkerRecord(),
      seat_mismatch: matchedWorkerRecord(), // 记录侧 effort=high；声明 medium → mismatched
    });
    // 组件层全 pass——组件通过不得把 seat_undet 抬出 undeterminable。
    writeComponentLedger(runDir, { "backend:codex@92209bb": componentRecord() });

    const server = createWaoMcpServer({ registryPath, runDir });
    const client = await buildInMemoryClient(server);
    try {
      const { parsed } = await callRegistryList(client, { detail: "certificationEvidence" });
      const byId = new Map(parsed.certificationEvidence.map((r) => [r.id, r]));
      assert.equal(byId.get("seat_matched").applicability, "matched");
      assert.equal(byId.get("seat_mismatch").applicability, "mismatched");
      assert.equal(byId.get("seat_undet").applicability, "undeterminable",
        "component pass + no combined record stays undeterminable (never green)");
      // 三态在同一响应里同时在场且互不相同（投影未折叠）。
      assert.equal(new Set(parsed.certificationEvidence.map((r) => r.applicability)).size, 3);
      // 限制项点名各态的"为什么"（信息保真：判定理由随行）。
      assert.match(byId.get("seat_mismatch").limitations.join(" "), /effort-mismatch/);
      assert.match(byId.get("seat_undet").limitations.join(" "), /no-worker-record/);
      // 缺席显式化：seat_undet 的组合列写 record=none，不是省略字段。
      assert.match(byId.get("seat_undet").combined, /record=none/);
      assert.ok(!NO_MERGED_GREEN_RE.test(JSON.stringify(parsed)), "no derived overall-usable boolean");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// 4. 两本台账的来源状态经 MCP 投影分别可辨：
//    ok / missing / unparseable / read-error，两账独立、互不折叠。
// =====================================================================

test("ADR32-MCP-4: both ledger source states stay separately distinguishable (ok/missing/unparseable/read-error)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-adr32-m4-"));
  try {
    // (a) 两账皆缺文件（空 runDir）→ 双 missing。
    {
      const registryPath = makeRegistry(dir, { seat: agentEntry(dir, "high") });
      const runDir = makeRunDir(dir, "-a");
      const server = createWaoMcpServer({ registryPath, runDir });
      const client = await buildInMemoryClient(server);
      try {
        const { parsed } = await callRegistryList(client, { detail: "certificationEvidence" });
        const row = parsed.certificationEvidence[0];
        assert.equal(row.summaryLedgerState, "missing", "summary ledger missing visible");
        assert.equal(row.componentLedgerState, "missing", "component ledger missing visible");
        assert.equal(row.applicability, "undeterminable", "missing evidence is never green");
      } finally {
        await client.close();
        await server.close();
      }
    }
    // (b) 一账 ok + 另一账 unparseable（同一 payload 两态并列、独立判定）。
    {
      const registryPath = makeRegistry(dir, { seat: agentEntry(dir, "high") });
      const runDir = makeRunDir(dir, "-b");
      writeSummary(runDir, { seat: matchedWorkerRecord() });
      writeFileSync(join(runDir, "component-checks.json"), "{ broken", "utf8");
      const server = createWaoMcpServer({ registryPath, runDir });
      const client = await buildInMemoryClient(server);
      try {
        const { parsed } = await callRegistryList(client, { detail: "certificationEvidence" });
        const row = parsed.certificationEvidence[0];
        assert.equal(row.summaryLedgerState, "ok", "summary ledger ok visible");
        assert.equal(row.componentLedgerState, "unparseable", "component ledger unparseable visible");
        assert.equal(row.applicability, "matched", "component source bad does not swallow the combined verdict (layered)");
        assert.match(row.limitations.join(" "), /component-ledger:unparseable/);
      } finally {
        await client.close();
        await server.close();
      }
    }
    // (c) 组合账 unparseable + 组件账 missing —— 两态不同且同时在场。
    {
      const registryPath = makeRegistry(dir, { seat: agentEntry(dir, "high") });
      const runDir = makeRunDir(dir, "-c");
      writeFileSync(join(runDir, "reliability-summary.json"), "{ not valid json", "utf8");
      const server = createWaoMcpServer({ registryPath, runDir });
      const client = await buildInMemoryClient(server);
      try {
        const { parsed } = await callRegistryList(client, { detail: "certificationEvidence" });
        const row = parsed.certificationEvidence[0];
        assert.equal(row.summaryLedgerState, "unparseable");
        assert.equal(row.componentLedgerState, "missing");
        assert.equal(row.applicability, "undeterminable", "unparseable ledger is never green");
        assert.match(row.limitations.join(" "), /reliability-ledger:unparseable/);
      } finally {
        await client.close();
        await server.close();
      }
    }
    // (d) 读取错误（read-error）：目录占位文件路径（EISDIR，跨平台非 ENOENT）
    //     ——真实服务、真实读取路径；read-error 不得折叠成 missing/unparseable。
    {
      const registryPath = makeRegistry(dir, { seat: agentEntry(dir, "high") });
      const runDir = makeRunDir(dir, "-d");
      writeSummary(runDir, { seat: matchedWorkerRecord() });
      mkdirSync(join(runDir, "component-checks.json")); // 目录占位 → readFile EISDIR
      const server = createWaoMcpServer({ registryPath, runDir });
      const client = await buildInMemoryClient(server);
      try {
        const { parsed } = await callRegistryList(client, { detail: "certificationEvidence" });
        const row = parsed.certificationEvidence[0];
        assert.equal(row.summaryLedgerState, "ok");
        assert.equal(row.componentLedgerState, "read-error",
          "read-error survives the MCP projection (not collapsed to missing/unparseable)");
        const limits = row.limitations.join(" ");
        assert.match(limits, /component-ledger:read-error/);
        assert.ok(!/component-ledger:(missing|unparseable)/.test(limits),
          "read-error must not be folded into missing/unparseable");
      } finally {
        await client.close();
        await server.close();
      }
    }
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// 5. 限制与来源未丢弃：drill 转录回查性断裂浮出为限制项（不改三态）；
//    组合 conditional（非 certified）如实可见——适用性不吞质量事实。
// =====================================================================

test("ADR32-MCP-5: limitations column carries drill-evidence breakage and non-certified combined status", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-adr32-m5-"));
  try {
    const registryPath = makeRegistry(dir, {
      seat_drill: agentEntry(dir, "high"),
      seat_cond: agentEntry(dir, "high"),
      seat_hist: agentEntry(dir, "high"),
    });
    const runDir = makeRunDir(dir);
    writeSummary(runDir, {
      // drillRunIds 记录了 id，但 runs/reliability/<id>.jsonl 不在场 → 断裂浮出。
      seat_drill: matchedWorkerRecord({
        executionProfile: {
          ...matchedWorkerRecord().executionProfile,
          drillRunIds: { sentinel: "run_gone" },
        },
      }),
      // 身份/画像全等但 status=conditional：适用性 matched ≠ 质量绿。
      seat_cond: matchedWorkerRecord({ status: "conditional" }),
      // B2 钉②（详情层）：历史通过 + 本次失败——status 反映本次失败，历史全绿
      // 时间只作历史事实保留（summary 层钉见 reliabilityCertification.test.js）。
      seat_hist: matchedWorkerRecord({
        status: "draft-only",
        lastHealthyRunAt: "2026-08-10T00:00:00.000Z",
        lastFullHealthyRunAt: "2026-08-10T00:00:00.000Z",
      }),
    });
    const server = createWaoMcpServer({ registryPath, runDir });
    const client = await buildInMemoryClient(server);
    try {
      const { parsed } = await callRegistryList(client, { detail: "certificationEvidence" });
      const byId = new Map(parsed.certificationEvidence.map((r) => [r.id, r]));
      const drill = byId.get("seat_drill");
      assert.equal(drill.applicability, "matched", "resolvability is a parallel fact, not a verdict input");
      assert.match(drill.limitations.join(" "), /drill-evidence-unresolvable:sentinel/,
        "drill transcript breakage survives the MCP projection");
      const cond = byId.get("seat_cond");
      assert.equal(cond.applicability, "matched", "identity match is about applicability, not quality");
      assert.match(cond.combined, /status=conditional/, "non-certified combined status stays visible");
      const hist = byId.get("seat_hist");
      assert.match(hist.combined, /status=draft-only/, "this-run failure stays visible (not overridden by history)");
      assert.match(hist.combined, /lastFullHealthy=2026-08-10T00:00:00\.000Z/,
        "historical all-green timestamp preserved as a forensic fact");
      assert.equal(hist.applicability, "matched", "applicability is parallel to quality — never merged into green");
      assert.ok(!NO_MERGED_GREEN_RE.test(JSON.stringify(parsed)), "no derived overall-usable boolean");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// 6. 输入闭集：detail 只接受 "certificationEvidence"；坏值在 wire 层被拒，
//    证据服务零调用；额外键仍被拒（path override 不因新参数复活）。
// =====================================================================

test("ADR32-MCP-6: detail is a closed set — out-of-set values rejected before the service runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-adr32-m6-"));
  let evidenceCalls = 0;
  try {
    const registryPath = makeRegistry(dir, { seat: agentEntry(dir, "high") });
    const runDir = makeRunDir(dir);
    const server = createWaoMcpServer({
      registryPath, runDir,
      getCertificationEvidenceFn: async () => { evidenceCalls += 1; return []; },
    });
    const client = await buildInMemoryClient(server);
    try {
      for (const bad of ["bogus", "", "CertificationEvidence", 42, null, ["certificationEvidence"]]) {
        let rejected = false;
        try {
          const res = await client.callTool({
            name: "registry_list",
            arguments: { detail: bad },
          });
          assert.equal(res.isError, true, "wire rejects detail=" + JSON.stringify(bad));
          rejected = true;
        } catch {
          rejected = true; // protocol-level rejection is a valid rejection
        }
        assert.ok(rejected, "detail=" + JSON.stringify(bad) + " rejected");
      }
      assert.equal(evidenceCalls, 0, "evidence service never called for a bad detail value");
      // 旧防线不回归：额外键仍被拒（path override 不因新参数复活）。
      const res = await client.callTool({
        name: "registry_list",
        arguments: { registryPath: "/attacker/x" },
      });
      assert.equal(res.isError, true, "extra keys still rejected (strict input)");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// 7. fail-closed：证据服务抛错/形状违约 → 整次调用固定错误文本，
//    绝不静默省略详情键（否则被读成"查过了、没有证据行"）。
// =====================================================================

test("ADR32-MCP-7: evidence service throw / malformed rows fail closed to the fixed error text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-adr32-m7-"));
  try {
    const registryPath = makeRegistry(dir, { seat: agentEntry(dir, "high") });
    const runDir = makeRunDir(dir);

    // (a) 服务抛错（含泄漏诱饵）→ 固定安全文本，无载荷。
    {
      const fake = async () => {
        throw new Error("evidence read failed at C:\secret\path with token xyz");
      };
      const server = createWaoMcpServer({ registryPath, runDir, getCertificationEvidenceFn: fake });
      const client = await buildInMemoryClient(server);
      try {
        const res = await client.callTool({ name: "registry_list", arguments: { detail: "certificationEvidence" } });
        assert.equal(res.isError, true, "service throw fails closed");
        const text = res.content?.map((b) => b.text ?? "").join(" ") ?? "";
        assert.match(text, /registry_list failed/, "fixed safe text");
        assert.ok(!text.includes("C:\secret"), "no path leak");
        assert.equal(res.structuredContent, undefined, "no partial payload");
      } finally {
        await client.close();
        await server.close();
      }
    }

    // (b) 非数组结果（形状违约）→ 同样 fail-closed，不折叠成空证据行成功。
    {
      const server = createWaoMcpServer({
        registryPath, runDir,
        getCertificationEvidenceFn: async () => ({ nope: true }),
      });
      const client = await buildInMemoryClient(server);
      try {
        const res = await client.callTool({ name: "registry_list", arguments: { detail: "certificationEvidence" } });
        assert.equal(res.isError, true, "non-array rows fail closed");
        assert.equal(res.structuredContent, undefined, "no observed-empty success payload");
      } finally {
        await client.close();
        await server.close();
      }
    }

    // (c) 越界枚举行（伪造适用性伪态）→ schema 层 fail-closed。
    {
      const fakeRows = [{
        id: "seat",
        declared: { backend: "codex", modelId: "gpt-6-astra", providerID: null, providerKey: null, effort: "high" },
        componentObserved: { state: "ok", llmKeyDerivable: true, backend: [], llm: [], truncated: false },
        combined: { state: "ok", record: null },
        applicability: "definitely-fine", // 闭集外伪态
        limitationsAndSources: { limitations: [], sources: [] },
      }];
      const server = createWaoMcpServer({
        registryPath, runDir,
        getCertificationEvidenceFn: async () => fakeRows,
      });
      const client = await buildInMemoryClient(server);
      try {
        const res = await client.callTool({ name: "registry_list", arguments: { detail: "certificationEvidence" } });
        assert.equal(res.isError, true, "out-of-set applicability fails closed (never fabricated green)");
        assert.equal(res.structuredContent, undefined, "no payload leaked past the schema");
      } finally {
        await client.close();
        await server.close();
      }
    }
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// 8. wire 面声明（additive-only）：registry_list input 增恰一个可选闭集
//    detail；output 增恰一个可选 certificationEvidence；22 工具闭集不变；
//    详情不得复制进 lead_preflight / run_await_result。
// =====================================================================

test("ADR32-MCP-8: tools/list declares the additive detail member; evidence NOT copied to other tools", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-adr32-m8-"));
  try {
    const registryPath = makeRegistry(dir, { seat: agentEntry(dir, "high") });
    const server = createWaoMcpServer({ registryPath, runDir: join(dir, "runs") });
    const client = await buildInMemoryClient(server);
    try {
      const tools = (await client.listTools()).tools;
      // 工具闭集：数量与顺序仍是冻结 SSOT（不新增工具）。
      assert.deepEqual(tools.map((t) => t.name), TOOLS, "frozen 22-tool surface unchanged");

      const rl = tools.find((t) => t.name === "registry_list");
      // 输入：恰一个可选成员 detail，闭集枚举；strict 不变。
      assert.deepEqual(
        Object.keys(rl.inputSchema.properties ?? {}).sort(),
        ["detail"],
        "input gains exactly one member",
      );
      assert.equal(rl.inputSchema.additionalProperties, false, "input stays strict");
      assert.deepEqual(
        (rl.inputSchema.required ?? []),
        [],
        "detail is optional (default call shape unchanged)",
      );
      assert.deepEqual(
        rl.inputSchema.properties.detail.enum,
        ["certificationEvidence"],
        "detail closed set on the wire",
      );
      // 输出：certificationEvidence 可选；三既有键仍必填（默认契约不动）。
      assert.deepEqual(
        Object.keys(rl.outputSchema.properties ?? {}).sort(),
        ["agents", "certificationEvidence", "issues", "issuesTruncated"],
        "output gains exactly one optional member",
      );
      assert.deepEqual(
        (rl.outputSchema.required ?? []).sort(),
        ["agents", "issues", "issuesTruncated"],
        "the three prior output members stay required (default contract intact)",
      );
      assert.equal(rl.outputSchema.properties.certificationEvidence.type, "array");

      // 详情不复制进 lead_preflight / run_await_result。
      for (const name of ["lead_preflight", "run_await_result"]) {
        const t = tools.find((x) => x.name === name);
        const dumped = JSON.stringify(t.inputSchema) + JSON.stringify(t.outputSchema);
        assert.ok(!dumped.includes("certificationEvidence"),
          name + " does not carry the evidence detail (not copied)");
      }
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// 9. audit11（2026-09-23）两缺口经 MCP 投影保真：①未预标注的自然过期（组件
//    自身时间 / 夹具资格）作为限制项透出（绝不淡化成"无"）；②lastFullHealthyRunAt
//    缺席渲染 lastFullHealthy=?（缺席显示 ?、不整项省略）。
// =====================================================================

test("ADR32-MCP-9 (audit11): natural-expiry limitations and lastFullHealthy=? survive the wire projection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-adr32-m9-"));
  try {
    const registryPath = makeRegistry(dir, {
      seat_exp: agentEntry(dir, "high"),
      seat_nofull: agentEntry(dir, "high"),
    });
    const runDir = makeRunDir(dir);
    writeSummary(runDir, {
      seat_exp: matchedWorkerRecord(),
      // 有 status、缺全绿时间戳（legacy 半迁移形状）→ lastFullHealthy=?。
      seat_nofull: matchedWorkerRecord({ lastFullHealthyRunAt: undefined }),
    });
    // 组件账（codex 前缀对每个 codex 席位都可见——观测按前缀列出）：
    // ①记录自身时间自然过期（无预标注）②夹具资格自然过期（记录自身时间新鲜）。
    writeComponentLedger(runDir, {
      "backend:codex@92209bb": componentRecord({ lastVerifiedAt: "2026-08-08T00:00:00.000Z" }),
      "backend:codex@92209bb#drift": componentRecord({
        key: "backend:codex@92209bb#drift",
        fixture: { qualifiedBy: "composition-cert", qualifiedAt: "2026-08-08T00:00:00.000Z" },
      }),
    });
    const server = createWaoMcpServer({ registryPath, runDir });
    const client = await buildInMemoryClient(server);
    try {
      const { parsed } = await callRegistryList(client, { detail: "certificationEvidence" });
      const byId = new Map(parsed.certificationEvidence.map((r) => [r.id, r]));
      const limits = byId.get("seat_exp").limitations.join(" ");
      assert.match(limits, /component-expired:/, "record natural expiry surfaces as a limitation through MCP");
      assert.match(limits, /component-fixture-decayed:/, "fixture natural expiry surfaces as a limitation through MCP");
      assert.match(byId.get("seat_nofull").combined, /lastFullHealthy=\?/,
        "absent all-green timestamp renders ? on the wire (never silently omitted)");
      // 有值时保留的对照：ADR32-MCP-5 seat_hist 已钉 lastFullHealthy=2026-08-10…。
      assert.ok(!NO_MERGED_GREEN_RE.test(JSON.stringify(parsed)), "no derived overall-usable boolean");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});
