/**
 * 通用 JSONL 行流解析器（M2-2）。
 *
 * 职责：
 *   - 维护行缓冲区，feed(chunk) 按换行切分完整行
 *   - 对每完整行 try-parse JSON；parse 失败的行静默跳过（codex 容错：事件间混入非 JSON 日志行）
 *   - 子类实现 handleLine(obj) → RunEvent[]，负责把解析出的对象翻译成事件
 *
 * 不负责"什么是完成"判定——那是子类的职责。
 * 跨 chunk 的不完整行被缓冲，直到收到换行符或 flush()。
 */
export class LineStreamParser {
  constructor() {
    this.buffer = "";
    // ADR-0031 §3.6 形状的 provider 会话复用（2026-09-21）：运行时**自己**的
    // provider 会话 id，只在 wire 广告时才捕获。null = wire 没广告（绝不猜）。
    // ProcessBackend 在流结束后读取，由 runner 运行期补记进 run 转录。
    this.providerSessionId = null;
  }

  /** wire 上观察到的 provider 会话 id（运行时未广告时为 null）。 */
  sessionId() {
    return this.providerSessionId;
  }

  /**
   * 可选接口：provider 自报的失败原话（取哪一条由子类定）。基类没有这个事实 → null。
   * ProcessBackend 只在"非零退出且解析器没产出 done"的兜底路径读它，用来把运行时
   * 给出的原因本身带进 run.error；返回 null 或未覆写时，退出报错文案逐字不变。
   * 形状 { runtime, message }：runtime 是报这条原话的运行时标签，共享代码只拼接、
   * 绝不据此分支；message 不在解析器里截断——脱敏按完整密钥值匹配，任何先截都会把
   * 跨在截断点上的值切碎、前缀漏出；有界截断只由共享层在脱敏之后做（保留开头）。
   */
  failureReason() {
    return null;
  }

  feed(chunk) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    this.buffer += text;
    const events = [];
    let idx;
    // 按 \n 切分（兼容 \r\n：行尾 \r 在 JSON.parse 时无害，但为干净先 strip）
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      let line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      line = line.replace(/\r$/, "");
      const obj = this.tryParse(line);
      if (obj !== undefined) {
        const emitted = this.handleLine(obj);
        if (emitted?.length) events.push(...emitted);
      }
    }
    return events;
  }

  flush() {
    const events = [];
    const remaining = this.buffer.replace(/\r$/, "").trim();
    this.buffer = "";
    if (remaining) {
      const obj = this.tryParse(remaining);
      if (obj !== undefined) {
        const emitted = this.handleLine(obj);
        if (emitted?.length) events.push(...emitted);
      }
    }
    return events;
  }

  tryParse(line) {
    const trimmed = line.trim();
    if (!trimmed) return undefined;
    try {
      return JSON.parse(trimmed);
    } catch {
      // 非 JSON 行（codex 的 ERROR 日志、空行等）静默跳过
      return undefined;
    }
  }

  /**
   * 子类覆写：把解析出的 JSON 对象翻译成 RunEvent[]。
   * @returns {Array} RunEvent[]（可为空）
   */
  handleLine(_obj) {
    return [];
  }
}
