import assert from "node:assert/strict";
import { test } from "node:test";

import { createWaoMcpServer } from "../src/mcp/server.js";
import {
  getRunDelivery,
  getRunDeliveryReadiness,
  projectDeliveryReadiness,
} from "../src/application/runDelivery.js";
import { getRunStatus } from "../src/application/runStatus.js";
import { runsCommand } from "../src/commands/runs.js";

async function buildInMemoryClient(server) {
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const client = new Client(
    { name: "wao-m11-11d-client", version: "0.0.1" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function ordinaryRunEvents(runId) {
  return [
    { seq: 1, ts: "2026-07-26T00:00:00.000Z", type: "run.submitted", runId, agentId: "researcher" },
    { seq: 2, ts: "2026-07-26T00:00:01.000Z", type: "run.started", runId, agentId: "researcher" },
    { seq: 3, ts: "2026-07-26T00:00:02.000Z", type: "run.completed", runId, agentId: "researcher" },
  ];
}

test("M11-11D-RED-1: ordinary non-delivery run returns structured not-requested truth", async () => {
  const runId = "run_m111d_non_delivery";
  const result = await getRunDelivery({
    runId,
    runDir: "C:\\synthetic-runs",
    readTranscriptFn: async () => ordinaryRunEvents(runId),
  });
  assert.deepEqual(result, {
    runId,
    terminalState: "completed",
    deliveryAvailable: false,
    deliveryRequested: false,
    deliveryFailure: null,
  });
});

test("M11-11D-RED-2: MCP run_delivery preserves ordinary non-delivery as success", async () => {
  const runId = "run_m111d_mcp_non_delivery";
  const server = createWaoMcpServer({
    registryPath: "C:\\synthetic\\agents.json",
    runDir: "C:\\synthetic-runs",
    getRunDeliveryFn: async () => ({
      runId,
      terminalState: "completed",
      deliveryAvailable: false,
      deliveryRequested: false,
      deliveryFailure: null,
    }),
  });
  const client = await buildInMemoryClient(server);
  try {
    const response = await client.callTool({ name: "run_delivery", arguments: { runId } });
    assert.notEqual(response.isError, true);
    assert.deepEqual(response.structuredContent, {
      runId,
      terminalState: "completed",
      deliveryAvailable: false,
      deliveryRequested: false,
      baseCommit: null,
      deliveryCommit: null,
      changedFileCount: null,
      changedPaths: null,
      changedPathsTruncated: null,
      verificationStatus: null,
      verificationFailureCode: null,
      verificationFailureSummary: null,
      acceptanceStatus: null,
      decisionType: null,
      deliveryFailure: null,
      // M12-1S1: additive nullable candidateInventory (null outside a bound
      // disallowed_path failure).
      candidateInventory: null,
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test("M11-11D-RED-3: stop_verified has a Lead-readable runtime-quiet meaning", async () => {
  const runId = "run_m111d_stop_meaning";
  const events = [
    ...ordinaryRunEvents(runId),
    {
      seq: 4,
      ts: "2026-07-26T00:00:03.000Z",
      type: "run.stop_verified",
      runId,
      agentId: "researcher",
      path: "_runCleanup",
    },
  ];
  const status = await getRunStatus({
    runId,
    runDir: "C:\\synthetic-runs",
    readTranscriptFn: async () => events,
  });
  assert.equal(status.lastEventType, "run.stop_verified");
  assert.equal(status.lastEventMeaning, "runtime_quiet_verified");
});

test("M11-11D-RED-4: removed forecast command fails explicitly instead of running an estimate", async () => {
  await assert.rejects(
    () => runsCommand(["forecast", "--agents", "coder_hq"], { runDir: "C:\\synthetic-runs" }),
    /removed|unavailable|not supported/i,
  );
});

test("M11-11D-CLOSEOUT-1: pre-fork delivery intent survives runner startup failure", async () => {
  const runId = "run_m111d_startup_failure";
  const events = [
    {
      seq: 1,
      ts: "2026-07-26T00:00:00.000Z",
      type: "run.background_submitted",
      runId,
      agentId: "coder_hq",
      deliveryRequested: true,
    },
    {
      seq: 2,
      ts: "2026-07-26T00:00:01.000Z",
      type: "run.started",
      runId,
      agentId: "coder_hq",
      backend: "backgroundRunner",
    },
    {
      seq: 3,
      ts: "2026-07-26T00:00:02.000Z",
      type: "run.error",
      runId,
      agentId: "coder_hq",
      phase: "startup",
    },
  ];

  assert.equal(projectDeliveryReadiness(events, runId), "ambiguous");
  const result = await getRunDelivery({
    runId,
    runDir: "C:\\synthetic-runs",
    readTranscriptFn: async () => events,
  });
  assert.equal(result.deliveryRequested, true);

  let sleepCount = 0;
  const readiness = await getRunDeliveryReadiness({
    runId,
    runDir: "C:\\synthetic-runs",
    waitMs: 300000,
    readTranscriptFn: async () => events,
    sleepFn: async () => { sleepCount += 1; },
  });
  assert.equal(readiness.readiness, "ambiguous");
  assert.equal(readiness.waitReturnedEarly, true);
  assert.equal(sleepCount, 0, "terminal run returns without burning the wait window");

  const foreignOnly = events.map((event) => ({ ...event, runId: "run_foreign" }));
  assert.equal(
    projectDeliveryReadiness(foreignOnly, runId),
    "not_requested",
    "foreign pre-fork intent cannot bind to the requested run",
  );
});
