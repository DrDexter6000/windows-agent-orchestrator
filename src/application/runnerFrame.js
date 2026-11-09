// src/application/runnerFrame.js
//
// TD-347（第 93 批）：runner 启动桥的管道帧协议（父子两端共用的单一实现）。
//
// WMI 路径里，控制面只经 Win32_Process.Create 起一个短命的桥进程（src/runnerBroker.js，
// 父进程是 WmiPrvSE.exe，不随宿主重启 MCP 服务而死）；runner 的 execPath/argv/env/
// cwd/prompt/stderrPath 经命名管道用一帧载荷交给桥，桥回一帧 {runnerPid, handoff}。
// 帧不进命令行：凭据值在 env 里、任务书在 prompt 里，命令行长度与转义都不是问题。
//
// 帧格式：4 字节大端长度 + UTF-8 JSON，一帧即止（两端都只读一帧，多余字节忽略）。
// 大小上限挡住坏长度头（随机大数）与异常载荷。两端（application 的启动模块与
// adapters 的桥入口）import 同一份实现——线上格式不漂移。
//
// Architectural contract:
//   - 叶子模块：零相对 import（只 node:buffer），不读环境，不在 import 时做事。
//   - No argv parsing, no console.log, no process.exit.

import { Buffer } from "node:buffer";

/** 单帧上限（长度头 + JSON 体）。载荷=完整 env + 任务书，几 MB 余量足够。 */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/** 帧体超过上限（编码侧防呆 / 解码侧坏长度头）。 */
export class FrameTooLargeError extends Error {
  constructor(byteLength) {
    super(`runner frame exceeds ${MAX_FRAME_BYTES} bytes (${byteLength})`);
    this.name = "FrameTooLargeError";
    this.byteLength = byteLength;
  }
}

/** 帧收到了但 JSON 解析不开 / 形状不对。 */
export class FrameFormatError extends Error {
  constructor(detail) {
    super(`runner frame is malformed (${detail})`);
    this.name = "FrameFormatError";
    this.detail = detail;
  }
}

/**
 * 编一帧：4 字节大端长度 + UTF-8 JSON。体超上限抛 FrameTooLargeError（调用方
 * 在起任何进程之前失败，不产生半启动状态）。
 * @param {object} value
 * @returns {Buffer}
 */
export function encodeFrame(value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.byteLength > MAX_FRAME_BYTES) {
    throw new FrameTooLargeError(body.byteLength);
  }
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.byteLength, 0);
  return Buffer.concat([head, body]);
}

/**
 * 增量解码器：喂进任意切分的字节，凑齐一帧后返回该帧并停（单帧协议，多余的
 * 字节只当噪声丢掉）。半包返回 incomplete；长度头超上限或 JSON 解析失败抛错
 * （调用方按"帧坏了"收口，绝不把半帧当整帧）。
 */
export class FrameDecoder {
  constructor({ maxBytes = MAX_FRAME_BYTES } = {}) {
    this.maxBytes = maxBytes;
    this.buffer = Buffer.alloc(0);
    this.done = false;
  }

  /**
   * @param {Buffer} chunk
   * @returns {{status:"frame", value:object}|{status:"incomplete"}}
   * @throws {FrameTooLargeError|FrameFormatError}
   */
  push(chunk) {
    if (this.done) return { status: "incomplete" };
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.buffer = this.buffer.length === 0 ? part : Buffer.concat([this.buffer, part]);
    if (this.buffer.length < 4) return { status: "incomplete" };
    const declared = this.buffer.readUInt32BE(0);
    if (declared > this.maxBytes) {
      this.done = true;
      throw new FrameTooLargeError(declared);
    }
    if (this.buffer.length < 4 + declared) return { status: "incomplete" };
    const body = this.buffer.subarray(4, 4 + declared).toString("utf8");
    this.done = true;
    let value;
    try {
      value = JSON.parse(body);
    } catch {
      // 不回显 e.message：V8 的 JSON 报错带源文本片段，帧体可能含敏感载荷。
      throw new FrameFormatError("json parse failed");
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new FrameFormatError("frame is not a JSON object");
    }
    return { status: "frame", value };
  }
}

/**
 * 桥端校验载荷形状（父端发来的 {execPath, args, env, cwd, prompt, stderrPath,
 * deadlineAt}）。deadlineAt 是父端总期限的绝对时刻（epoch 毫秒）：桥过了它就不再
 * 起 runner（第 93 批续修 3——桥按父端的期限办事，不自设交接时限）。
 * 只认形状，不看语义；任何不合形状都抛 FrameFormatError——桥不猜、不补默认值。
 * @returns {{execPath:string, args:string[], env:Record<string,string>, cwd:string,
 *            prompt:string|null, stderrPath:string, deadlineAt:number}}
 */
export function validateBrokerPayload(payload) {
  const bad = (why) => new FrameFormatError(`payload: ${why}`);
  if (payload === null || typeof payload !== "object") throw bad("not an object");
  const { execPath, args, env, cwd, prompt, stderrPath, deadlineAt } = payload;
  if (typeof execPath !== "string" || execPath.length === 0) throw bad("execPath");
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) throw bad("args");
  if (env === null || typeof env !== "object" || Array.isArray(env)
    || Object.keys(env).some((k) => typeof k !== "string" || typeof env[k] !== "string")) {
    throw bad("env");
  }
  if (typeof cwd !== "string" || cwd.length === 0) throw bad("cwd");
  if (prompt !== null && typeof prompt !== "string") throw bad("prompt");
  if (typeof stderrPath !== "string" || stderrPath.length === 0) throw bad("stderrPath");
  if (!(Number.isInteger(deadlineAt) && deadlineAt > 0)) throw bad("deadlineAt");
  return { execPath, args, env, cwd, prompt, stderrPath, deadlineAt };
}

/**
 * 父端校验回帧形状（桥回的 {runnerPid, handoff}）。handoff 是
 * writeRunnerPrompt 的闭集结果；runnerPid 拿不到时允许 null（回帧仍可判读）。
 * @returns {{runnerPid:number|null, handoff:"written"|"runner_exited"|"timeout"}}
 */
export function validateBrokerReply(reply) {
  const bad = (why) => new FrameFormatError(`reply: ${why}`);
  if (reply === null || typeof reply !== "object") throw bad("not an object");
  const { runnerPid, handoff } = reply;
  if (runnerPid !== null && !(Number.isInteger(runnerPid) && runnerPid > 0)) throw bad("runnerPid");
  if (handoff !== "written" && handoff !== "runner_exited" && handoff !== "timeout") throw bad("handoff");
  return { runnerPid, handoff };
}
