// R23-F/A 验收①（A 轮自带）：harness per-attempt TEMP 注入形状下，机器级路径必须免疫。
// 由 delivery spec 作为第一条验证命令执行——绿即证"闸的地基"在 harness 子进程 env 里成立。
import { inflightMarkerPath } from "../src/machineGatePaths.js";

const p = inflightMarkerPath();
const temp = (process.env.TEMP || process.env.TMP || "").replace(/[\\/]+$/, "");
const fail = (msg) => {
  console.error("PATH CHECK FAIL:", msg, "| resolved:", p, "| TEMP:", process.env.TEMP);
  process.exit(1);
};
if (temp && p.toLowerCase().includes(temp.toLowerCase())) fail("path derives from injected TEMP");
if (!/[\\/]wao[\\/]wao-canonical-test\.inflight$/.test(p.replace(/\\/g, "/"))) fail("path not under machine state dir");
console.log("PATH IMMUNE OK:", p, "| TEMP:", process.env.TEMP);
