// src/application/runsMigrateProjects.js
//
// TD-190 D3（2026-10-09 批，Owner 批准的分桶路线；kimi+opus 裁定会审
// consult_20261009081329035swaqvc）：存量转录按项目分桶的**迁移计划器
//（dry-run 唯一形态）**。职责：
//   1. 对 runs/ 根层每个 *.jsonl 用首事件 cwd 经 projectIdentity（D1）归桶；
//   2. 跳过保留目录（reliability/ 等——跨项目集中台账不分桶）与非终态 run
//      （追加中搬家会撕裂转录——opus 迁移风险面）；
//   3. 输出每桶文件数+字节数+跳过清单，作为 Owner 实迁点名前的完整预览
//      （kimi 加固项）与 R1-R6 规则对真实存量的冒烟（AGENTS 铁律：分类类
//      改动必须对真实转录冒烟）。
// 本批**只有 dry-run**：不做任何移动/写入——物理迁移在 Owner 显式点名后
// 另窗执行（届时按 ADR-0034 哈希校验清单式移动、幂等可续跑）。
//
// 架构契约：core 纯读服务；IO 全注入（测试可控）；不 import commands/mcp。

import { readdirSync as fsReaddirSync, statSync as fsStatSync, readFileSync as fsReadFileSync } from "node:fs";
import { identityOfFirstEvent, deriveProjectBucketSlug, RUNS_RESERVED_DIRNAMES, PROJECT_IDENTITY_RULES_VERSION } from "../projectIdentity.js";
import { TERMINAL_STATES } from "../transcript.js";

// 首事件类型闭集（实测：run.started / run.background_submitted，两者都带 cwd）。
const FIRST_EVENT_TYPES = new Set(["run.started", "run.background_submitted"]);

/**
 * 对 runDir 根层存量做分桶迁移计划（纯读，零写入）。
 *
 * @param {{runDir: string, io?: {readdirSync?: Function, statSync?: Function, readFileSync?: Function, realpath?: Function, platform?: NodeJS.Platform, tmpdir?: string}}} input
 * @returns {{rulesVersion: string, buckets: Array<{slug: string, displayName: string, projectKey: string, fileCount: number, bytes: number, skippedNonTerminal: string[]}>, scratchFileCount: number, scratchBytes: number, unattributed: Array<{file: string, reason: string}>, reservedDirsSkipped: string[], scanned: number, parseFailures: Array<{file: string, reason: string}>}}
 */
export function planProjectsMigration({ runDir, io = {} }) {
  const readdirSync = io.readdirSync ?? fsReaddirSync;
  const statSync = io.statSync ?? fsStatSync;
  const readFileSync = io.readFileSync ?? fsReadFileSync;
  const realpath = io.realpath ?? ((p) => p);

  const rulesVersion = PROJECT_IDENTITY_RULES_VERSION; // 与 projectIdentity SSOT 同源（td190-r2：R1-R7+slug v1）——
  // 计划与未来写入侧的桶归属事实都携带该版本（opus 补强 1 的读侧对应物）。

  const out = {
    rulesVersion,
    slugConflicts: [],
    buckets: [],
    scratchFileCount: 0,
    scratchBytes: 0,
    sandboxFileCount: 0,
    sandboxBytes: 0,
    sandboxHarnesses: [],
    unattributed: [],
    reservedDirsSkipped: [],
    scanned: 0,
    parseFailures: [],
  };
  const bucketByKey = new Map();

  let entries = [];
  try {
    entries = readdirSync(runDir);
  } catch {
    return out; // runDir 不存在——空计划（首次安装形态）
  }
  for (const name of entries) {
    const isJsonl = name.endsWith(".jsonl");
    let isDir = false;
    try {
      isDir = statSync(`${runDir}/${name}`.replace(/\/$/, "")).isDirectory?.() ?? false;
    } catch { /* stat 失败按文件处理，读取阶段如实报错 */ }
    // 保留目录（reliability/verify/smoke/…）与 .session-reuse 等状态目录：跨项目
    // 集中资产，不分桶、不迁移（记录在案供报告呈现）。
    if (isDir) {
      if (RUNS_RESERVED_DIRNAMES.includes(name)) out.reservedDirsSkipped.push(name);
      continue;
    }
    if (!isJsonl) continue;
    out.scanned += 1;
    const file = name;

    let first;
    try {
      first = JSON.parse(readFileSync(joinPath(runDir, file), "utf8").trim().split("\n")[0]);
    } catch (error) {
      out.parseFailures.push({ file, reason: `first line unreadable/unparseable: ${error?.message ?? error}` });
      continue;
    }
    if (!FIRST_EVENT_TYPES.has(first?.type)) {
      out.parseFailures.push({ file, reason: `first event type ${JSON.stringify(first?.type)} not in ${[...FIRST_EVENT_TYPES].join("/")}` });
      continue;
    }

    // 终态检测：最后一条 run.state_change 的 to 在终态闭集才算可迁（非终态=
    // 可能在追加，搬家撕裂转录——跳过并点名）。读失败按非终态处理
    // （fail-closed：不可证的绝不迁）。
    let state = null;
    try {
      const lines = readFileSync(joinPath(runDir, file), "utf8").trim().split("\n");
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        let ev;
        try { ev = JSON.parse(lines[i]); } catch { continue; }
        if (ev?.type === "run.state_change" && typeof ev.to === "string") { state = ev.to; break; }
      }
    } catch { /* 读取失败按非终态处理（fail-closed：不可证的绝不迁） */ }

    // 终审 M2/F3：经共享校验入口 identityOfFirstEvent——在档事实优先（校验闭集
    // 后采用；坏事实入 parseFailures 不静默掩盖），legacy 回退推导。list --project
    // 同一入口，两侧语义不分叉。
    const { identity, factError } = identityOfFirstEvent(first, {
      platform: io.platform ?? process.platform,
      realpath,
      tmpdir: io.tmpdir,
    });
    if (factError !== null) {
      out.parseFailures.push({ file, reason: `recorded project fact rejected: ${factError}` });
      continue;
    }
    const bucketSlugOf = (id) => (id.kind === "project"
      ? (id.bucket ?? deriveProjectBucketSlug({ kind: "project", key: id.key, displayName: id.displayName ?? basenameOf(id.key) }))
      : null);
    // 终审 F2：同 key 不同在档 bucket（或事实与推导桶名分叉）不得静默合并——
    // slugConflicts 如实上报（slug 冻结意图的边界：记录归属冻结，但冲突必须可见）。
    const slugForThisFile = bucketSlugOf(identity);

    if (identity.kind === "unattributed") {
      out.unattributed.push({ file, reason: identity.reason ?? "unattributed (recorded fact)" });
      continue;
    }
    if (identity.kind === "scratch") {
      if (!TERMINAL_STATES.includes(state)) continue; // 非终态一律跳过（各桶同规则）
      out.scratchFileCount += 1;
      out.scratchBytes += fileSizeOf(statSync, runDir, file);
      continue;
    }
    if (identity.kind === "sandbox") {
      // R7：真活不是探针——独立 _sandbox 桶（与 scratch 分开），非终态同规则跳过。
      if (!TERMINAL_STATES.includes(state)) continue;
      out.sandboxFileCount += 1;
      out.sandboxBytes += fileSizeOf(statSync, runDir, file);
      const tag = `${identity.harness}:${identity.worktreeName}${identity.repoHint ? `→${identity.repoHint}` : ""}`;
      if (!out.sandboxHarnesses.includes(tag)) out.sandboxHarnesses.push(tag);
      continue;
    }
    // kind === "project"
    let bucket = bucketByKey.get(identity.key);
    if (!bucket) {
      bucket = {
        slug: slugForThisFile,
        displayName: identity.displayName ?? basenameOf(identity.key),
        projectKey: identity.key,
        fileCount: 0,
        bytes: 0,
        skippedNonTerminal: [],
      };
      bucketByKey.set(identity.key, bucket);
      out.buckets.push(bucket);
    } else if (bucket.slug !== slugForThisFile) {
      out.slugConflicts.push({ key: identity.key, bucketSlug: bucket.slug, conflictingSlug: slugForThisFile, file });
    }
    if (!TERMINAL_STATES.includes(state)) {
      bucket.skippedNonTerminal.push(file);
      continue;
    }
    bucket.fileCount += 1;
    bucket.bytes += fileSizeOf(statSync, runDir, file);
  }
  out.buckets.sort((a, b) => b.fileCount - a.fileCount);
  return out;
}


function basenameOf(key) {
  const parts = String(key).replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || "project";
}

function joinPath(dir, file) {
  return `${dir.replace(/[/\\]+$/, "")}/${file}`;
}

function fileSizeOf(statSync, runDir, file) {
  try {
    return statSync(joinPath(runDir, file)).size ?? 0;
  } catch {
    return 0;
  }
}
