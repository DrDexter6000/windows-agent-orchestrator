// scripts/migration/inventory-runs.mjs
//
// 0045 §4.1/§4.2 案卷清单冻结器（迁移证据包的地基）。
//
// 用途：递归盘点证据库（runs/ 全部 *.jsonl 转录 + .wao/runs/consults/ 全部会审
// 组记录），逐文件记 {path, bytes, sha256}，输出清单 JSON 并打印清单自身的
// sha256。迁移（§4.2）前后各跑一次：文件级哈希守恒 + 计数守恒 = 证据未被
// 改写/丢失的机械证明（AGENTS.md 归档 hash-verified move 同族手法）。
//
// 纪律：只读源文件；输出写到显式目标路径（Windows 无歧义 /tmp——本脚本默认
// 输出 runs/inventory-0045-<label>.json，或 argv 指定）；不打印文件内容。
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const roots = ["runs", join(".wao", "runs", "consults")];
const label = process.argv[2] ?? "snapshot";
const outPath = process.argv[3] ?? `runs/inventory-0045-${label}.json`;

function walk(dir, acc) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // 目录不存在=空盘点（如首次运行无 consults）
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.isFile() && (p.endsWith(".jsonl") || p.endsWith(".json"))) {
      const buf = readFileSync(p);
      acc.push({
        path: relative(".", p).split(sep).join("/"),
        bytes: buf.byteLength,
        sha256: createHash("sha256").update(buf).digest("hex"),
      });
    }
  }
}

const files = [];
for (const r of roots) walk(r, files);
files.sort((a, b) => (a.path < b.path ? -1 : 1));
const manifest = {
  label,
  generatedAt: new Date().toISOString(),
  roots,
  count: files.length,
  totalBytes: files.reduce((n, f) => n + f.bytes, 0),
  files,
};
const body = JSON.stringify(manifest, null, 2) + "\n";
mkdirSync(".", { recursive: true });
writeFileSync(outPath, body, "utf8");
const manifestSha = createHash("sha256").update(body).digest("hex");
console.log(JSON.stringify({
  outPath,
  label,
  count: manifest.count,
  totalBytes: manifest.totalBytes,
  manifestSha256: manifestSha,
}));
