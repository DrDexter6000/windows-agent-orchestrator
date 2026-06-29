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
