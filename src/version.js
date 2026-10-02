// src/version.js
//
// WAO 版本常量（v0.2.0，决定 0038）。单一来源是仓库根 package.json 的 version
// 字段——与 src/mcp/server.js 的 SERVER_VERSION（MCP initialize serverInfo）同一
// SSOT 模式：动态读取，发版 bump package.json 即两处消费者自动同步。
//
// 独立成模块的原因：src/cli.js 尾部自执行 main()，任何消费方（测试/生成器/未来
// 的 doctor）import 本文件零副作用。
import { createRequire } from "node:module";

export const WAO_VERSION = createRequire(import.meta.url)("../package.json").version;
