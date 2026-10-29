// 后台 runner 的提示词经标准输入交接：派发方（runDispatch / runContinue）写入后关闭，
// runner 启动时读完。提示词不进 runner 的命令行——Windows 命令行有长度上限，长任务书
// 会被派发前的 argv 长度检查拒掉；以 "--" 开头的提示词还会被 runner 的参数解析吞掉。
//
// 交接带完整性核对：标志后面跟着提示词 UTF-8 字节的 sha256。只凭 EOF 分不清"写完了"
// 和"派发方写到一半退出了"，runner 读完先比对摘要，对不上就不启动 worker。
import { createHash } from "node:crypto";

export const PROMPT_STDIN_FLAG = "--prompt-stdin";

export function promptDigest(prompt) {
  return createHash("sha256").update(prompt ?? "", "utf8").digest("hex");
}

/** 派发方 runner argv 里的那一对：标志 + 摘要。 */
export function promptStdinArgs(prompt) {
  return [PROMPT_STDIN_FLAG, promptDigest(prompt)];
}

// runner 启动后第一件事就是读完 stdin；超过这个时限还没读完，按交接失败处理。
export const PROMPT_HANDOFF_TIMEOUT_MS = 30_000;
export const PROMPT_HANDOFF_TIMEOUT_TEXT = "prompt handoff timed out: the runner did not read its prompt";

/**
 * 派发方：把提示词写进 runner 的标准输入并关闭。结果三选一：
 *   "written"       —— 写完；
 *   "runner_exited" —— runner 先退出（写入报错），起不来的原因由它自己的启动失败路径落盘；
 *   "timeout"       —— runner 活着却一直不读（提示词大于管道缓冲时写入会一直挂着），
 *                      调用方须结束 runner，按启动失败收口。
 */
export function writeRunnerPrompt(child, prompt, { timeoutMs = PROMPT_HANDOFF_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const stdin = child?.stdin;
    // 真实 spawn 的管道必有 stdin；测试注入的假子进程可以没有。
    if (!stdin) {
      resolve("written");
      return;
    }
    let timer = null;
    const settle = (outcome) => {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
      resolve(outcome);
    };
    timer = setTimeout(() => settle("timeout"), timeoutMs);
    stdin.once("error", () => settle("runner_exited"));
    stdin.end(prompt ?? "", () => settle("written"));
  });
}

/** runner：读完标准输入作为提示词（UTF-8）。 */
export async function readRunnerPrompt(stream = process.stdin) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
