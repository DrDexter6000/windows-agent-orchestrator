// TD-99 跨进程仲裁测试 helper——被 test/terminalArbitration.test.js 用 child_process.fork 拉起。
//
// 协议（IPC message）：
//   parent → child: { cmd: "init", filePath, runId, agentId, targetState, reason }
//   child → parent: { cmd: "ready" }
//   parent → child: { cmd: "go" }
//   child → parent: { cmd: "result", accepted, state }
//   child → parent: { cmd: "done" }
//
// 收到 init 后构造 JsonlTranscript，ready 等待 go，go 后调 transitionState，报 result，退出。
import { JsonlTranscript } from "../src/transcript.js";

let transcript = null;
let targetState = null;
let reason = null;

process.on("message", async (msg) => {
  if (msg.cmd === "init") {
    transcript = new JsonlTranscript(msg.filePath, { runId: msg.runId, agentId: msg.agentId });
    targetState = msg.targetState;
    reason = msg.reason;
    process.send({ cmd: "ready" });
    return;
  }
  if (msg.cmd === "go") {
    try {
      const result = await transcript.transitionState("running", targetState, reason);
      process.send({ cmd: "result", accepted: result.accepted, state: result.state });
    } catch (error) {
      process.send({ cmd: "result", accepted: false, state: null, error: error.message });
    }
    process.send({ cmd: "done" });
  }
});
