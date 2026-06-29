/**
 * 最小端口分配器（M3-2）。
 *
 * 为 M5 多 opencode-serve 实例铺路。M3 只做分配记账（Set 跟踪），
 * 不做端口探测（bind 测试）——真正 bind 是 M5 的事。
 *
 * 不持久化（M3 单进程串行，跨进程端口协调留 daemon 阶段）。
 */
export class PortAllocator {
  constructor({ range = [30000, 31000], checkInUse } = {}) {
    if (!Array.isArray(range) || range.length !== 2 || range[0] > range[1]) {
      throw new Error("range must be [start, end] with start <= end");
    }
    this.start = range[0];
    this.end = range[1];
    this.allocated = new Set();
    this.checkInUse = checkInUse; // 可选：(port) => boolean，true 表示端口被外部占用
  }

  allocate() {
    for (let port = this.start; port <= this.end; port += 1) {
      if (this.allocated.has(port)) continue;
      if (this.checkInUse?.(port)) continue;
      this.allocated.add(port);
      return port;
    }
    throw new Error(`no available port in range [${this.start}, ${this.end}] (exhausted)`);
  }

  release(port) {
    this.allocated.delete(port);
  }
}
