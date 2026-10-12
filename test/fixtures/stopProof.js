// 决定 0069：Lead 面的 stop（MCP run_stop / CLI stop）必带理由与看到的转录位置。
// 机制测试并不关心这两项——这里给出对夹具恒有效的一组：位置取该运行转录里
// 绑定事件的最后一条 seq（没有 seq 的夹具为 0）。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const TEST_STOP_REASON = "test: exercising the stop mechanics";

function lastBoundSeq(runDir, runId) {
  const file = join(runDir, `${runId}.jsonl`);
  if (!existsSync(file)) return 0;
  let last = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e?.runId === runId && Number.isInteger(e.seq) && e.seq > last) last = e.seq;
    } catch { /* 坏行不参与 */ }
  }
  return last;
}

/** MCP run_stop 入参的两个必填项。 */
export function stopProof(runDir, runId) {
  return { reason: TEST_STOP_REASON, observedSeq: lastBoundSeq(runDir, runId) };
}

/** CLI stop 的两个必填 flag。 */
export function stopProofFlags(runDir, runId) {
  return ["--observed-seq", String(lastBoundSeq(runDir, runId)), "--reason", TEST_STOP_REASON];
}
