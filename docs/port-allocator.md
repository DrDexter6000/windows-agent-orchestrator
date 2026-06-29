# PortAllocator

> 模块：`src/portAllocator.js` · 里程碑：M3-2 · 状态：仅分配记账，不探测 bind

## 模块职责

为多 `opencode-serve` 实例（M5+）分配互不冲突的端口。当前职责刻意收窄：

- **只做内存中的分配记账**：用 `Set` 记录已分配端口。
- **不做端口探测（bind 测试）**：真正 bind 由消费方（M5）负责。
- **不持久化**：单进程串行场景够用；跨进程协调留待 daemon 阶段。

一句话：给定一个端口区间，按需取出第一个未占用端口，用完归还。

## API

### `new PortAllocator(options)`

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `options.range` | `[start, end]` | `[30000, 31000]` | 可分配端口区间，要求 `start <= end` |
| `options.checkInUse` | `(port) => boolean` | `undefined` | 可选外部探测回调；返回 `true` 视为端口被外部占用，跳过 |

构造时若 `range` 非法（非二元数组或 `start > end`）会 `throw`。

### `allocate()`

从 `start` 到 `end` 顺序扫描，返回**首个**未分配且未被外部占用的端口，并将其标记为已分配。

- **返回**：`number` —— 分配到的端口号。
- **抛错**：区间耗尽时 `throw new Error("no available port in range [...] (exhausted)")`。

### `release(port)`

归还端口，使其重新可被分配。对未分配端口调用无副作用（幂等）。

- **参数**：`port: number`
- **返回**：`undefined`

## 使用示例

### 基础：默认区间分配与归还

```js
import { PortAllocator } from "./src/portAllocator.js";

const pa = new PortAllocator();
const port = pa.allocate();   // 30000
const port2 = pa.allocate();  // 30001
pa.release(port);             // 30000 现在可再次分配
pa.allocate();                // 30000（首个可用）
```

### 自定义区间

```js
const pa = new PortAllocator({ range: [40000, 40100] });
pa.allocate(); // 40000
```

### 接入外部探测（避开系统已占用端口）

```js
import net from "node:net";

const isFree = (port) =>
  !net.createServer().listen(port).address(); // 简化示例，生产用 Promise 包装

const pa = new PortAllocator({
  range: [30000, 31000],
  checkInUse: (port) => !isFree(port),
});
```

> 注意：M3 本身不实现探测逻辑，`checkInUse` 仅提供挂钩点；真正的 bind 验证是消费方的事。

## 设计边界

| 能力 | 现在 | 留待 |
|------|------|------|
| 内存分配记账 | ✅ | — |
| 外部探测挂钩 | ✅（可选回调） | — |
| bind 探测实现 | ❌ | M5 |
| 跨进程/持久化 | ❌ | daemon 阶段 |
