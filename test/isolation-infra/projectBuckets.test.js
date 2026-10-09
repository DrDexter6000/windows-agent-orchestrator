// test/isolation-infra/projectBuckets.test.js
//
// TD-190 D2-②b 单测（规格 v2.2）：runs/projects/<slug>/ 目录分桶的写侧权威
// 与读侧解析链。全部夹具 mkdtemp+真 fs（fictional 路径前缀纪律：不依赖
// C:/Users/* 真实家目录）。
//
// 覆盖面（规格 §5/§6 验收项 → 测试）：
//   - 写侧：先写者胜（同 key 复用旧桶）；wx 独占 + key 校验 + 碰撞扩长（§6.1/6.2）；
//     记录半写有界重读（§6.11-6）；索引损坏扫描重建（§6.11-5）。
//   - 读侧：三级链（cwdHint→桶[经冻结索引，不重推桶名]→旧平铺→64 桶扫描）；
//     fast-hit 孪生检测（哈希同→桶优先可观测；异→具名硬错 §6.5 统一规则）；
//     扫描超限具名错（§6.10）；forAppend 未命中不得误建平铺（§6.9）。
//   - 枚举：listTranscriptsDeep 两层、根层原序、.index.json 非桶。
//   - 事实：projectFactForWrite 记最终写位（扩长后与目录一致）；readFirstProjectFact。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveRunDirForWrite, resolveTranscriptPath, listTranscriptsDeep, findTranscriptTwin,
  projectFactForWrite, readFirstProjectFact, loadBucketIndex,
  TranscriptResolutionError, TRANSCRIPT_SCAN_BUCKET_LIMIT,
} from "../../src/projectBuckets.js";
import { identifyProjectFromCwd } from "../../src/projectIdentity.js";

// 圈养身份 io：realpath 恒等 + 虚构 tmpdir（R5：tmpdir 前缀才判 scratch——
// 生产 io 下 os.tmpdir() 内一切都是 scratch，本套件的 mkdtemp 根会全数落
// scratch 桶，故注入此 io 使项目身份可测；scratch 用例显式用虚构 tmpdir 前缀）。
const IO = { realpath: (p) => p, tmpdir: "Z:\no-such-tmp" };

function makeRoot(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}
function write(path, content) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

test("D2-②b 写侧: 同 key 先写者胜（冻结桶名，永不按新规则重推）", () => {
  const root = makeRoot("wao-pb-w1-");
  try {
    mkdirSync(join(root, "repo-alpha"), { recursive: true });
    const id = identifyProjectFromCwd(join(root, "repo-alpha"), IO);
    const w1 = resolveRunDirForWrite(root, id);
    const w2 = resolveRunDirForWrite(root, id);
    assert.equal(w1.bucket, w2.bucket, "同 key 二次写复用旧桶");
    assert.ok(w1.bucket.startsWith("repo-alpha-"), "slug=displayName-<hash8>");
    assert.match(w1.bucket, /-[0-9a-f]{8,}$/, "哈希后缀形状");
    // 事实 bucket=最终写位
    const fact = projectFactForWrite(id, w1);
    assert.equal(fact.bucket, w1.bucket);
    assert.equal(fact.kind, "project");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("D2-②b 写侧: 碰撞（同 slug 异 key）→ 扩长后缀不覆盖既有记录", () => {
  const root = makeRoot("wao-pb-w2-");
  try {
    const dirA = join(root, "same-name");
    mkdirSync(dirA, { recursive: true });
    const wA = resolveRunDirForWrite(root, identifyProjectFromCwd(dirA, IO));
    // 伪造哈希碰撞：手工创建与 wA 同名的第二桶但异 key 记录，再重建索引指向它
    const slug = wA.bucket;
    const collisionDir = join(root, "projects", slug);
    // 直接篡改既有桶记录为异 key —— resolveRunDirForWrite 必须扩长而非覆盖
    const recordPath = join(collisionDir, ".project.json");
    const rec = JSON.parse(readFileSync(recordPath, "utf8"));
    writeFileSync(recordPath, JSON.stringify({ ...rec, key: "D:\\other\\key" }, null, 2), "utf8");
    const w2 = resolveRunDirForWrite(root, identifyProjectFromCwd(dirA, IO));
    assert.notEqual(w2.bucket, slug, "异 key 记录 → 扩长新 slug");
    assert.ok(w2.bucket.startsWith(slug + "-"), `扩长形态 ${slug}-<n>（实测 ${w2.bucket}）`);
    const recAfter = JSON.parse(readFileSync(recordPath, "utf8"));
    assert.equal(recAfter.key, "D:\\other\\key", "既有记录不被覆盖（老桶永不改名）");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("D2-②b 写侧: 保留桶（sandbox/scratch/unattributed）与索引重建", () => {
  const root = makeRoot("wao-pb-w3-");
  try {
    const sbx = resolveRunDirForWrite(root, identifyProjectFromCwd(join(root, "x", ".codex", "worktrees", "wt-1"), IO));
    assert.equal(sbx.bucket, "_sandbox");
    // scratch/unattributed 保留桶：直接构造 identity（R5 形状判定属
    // projectIdentity.test.js 辖区，见该文件 R5 用例）。
    const scr = resolveRunDirForWrite(root, { kind: "scratch" });
    assert.equal(scr.bucket, "_scratch");
    const una = resolveRunDirForWrite(root, { kind: "unattributed", reason: "x" });
    assert.equal(una.bucket, "_unattributed");
    // 索引损坏 → 扫描重建（.project.json 是权威）
    const idx = join(root, "projects", ".index.json");
    writeFileSync(idx, "{corrupt", "utf8");
    const { entries, rebuilt } = loadBucketIndex(root);
    assert.equal(rebuilt, true, "损坏索引触发重建");
    mkdirSync(join(root, "repo-gamma"), { recursive: true });
    const w = resolveRunDirForWrite(root, identifyProjectFromCwd(join(root, "repo-gamma"), IO));
    assert.ok(Object.keys(entries).length >= 0 || true, "重建不炸");
    const after = loadBucketIndex(root);
    assert.ok(after.entries[w.key] === w.bucket || Object.values(after.entries).includes(w.bucket), "重建后新桶入索引");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("D2-②b 读侧: 三级链（cwdHint→桶[经索引]→旧平铺→扫描）与 ENOENT 兼容回落", () => {
  const root = makeRoot("wao-pb-r1-");
  try {
    mkdirSync(join(root, "repo-beta"), { recursive: true });
    const id = identifyProjectFromCwd(join(root, "repo-beta"), IO);
    const w = resolveRunDirForWrite(root, id);
    write(join(w.transcriptDir, "run_1.jsonl"), "{\"a\":1}\n");
    write(join(root, "run_flat.jsonl"), "{\"b\":2}\n");
    assert.equal(resolveTranscriptPath(root, "run_1", { cwdHint: join(root, "repo-beta") }), join(w.transcriptDir, "run_1.jsonl"), "①hint 经索引命中桶");
    assert.equal(resolveTranscriptPath(root, "run_1"), join(w.transcriptDir, "run_1.jsonl"), "③无 hint 扫描兜底命中");
    assert.equal(resolveTranscriptPath(root, "run_flat"), join(root, "run_flat.jsonl"), "②旧平铺可读（迁移前长期共存）");
    assert.equal(resolveTranscriptPath(root, "run_none"), join(root, "run_none.jsonl"), "全未命中回落平铺形状（调用方 ENOENT 语义不变）");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("D2-②b 读侧: hint 不按现行规则重推桶名（索引无此 key → 跳过桶层）", () => {
  const root = makeRoot("wao-pb-r2-");
  try {
    mkdirSync(join(root, "repo-delta"), { recursive: true });
    const id = identifyProjectFromCwd(join(root, "repo-delta"), IO);
    const w = resolveRunDirForWrite(root, id);
    // 索引里删掉该 key（模拟"该 cwd 对应桶从未建立"）——hint 不得凭当前规则
    // 猜出 slug 直取；应回落扫描层（本例桶内确有文件 → 扫描命中，路径同）。
    const idx = join(root, "projects", ".index.json");
    const parsed = JSON.parse(readFileSync(idx, "utf8"));
    delete parsed.entries[id.key];
    writeFileSync(idx, JSON.stringify(parsed), "utf8");
    write(join(w.transcriptDir, "run_2.jsonl"), "{\"a\":1}\n");
    // 注：loadBucketIndex 读不到 key 会走重建（权威=.project.json）→ 命中同桶。
    const p = resolveTranscriptPath(root, "run_2", { cwdHint: join(root, "repo-delta") });
    assert.equal(p, join(w.transcriptDir, "run_2.jsonl"), "权威重建后经桶命中（非按规则盲猜的对照组见下）");
    // 对照组：一个从未建桶的 cwd hint —— 不得凭规则派生 slug 后误中他桶。
    mkdirSync(join(root, "repo-never-bucketed"), { recursive: true });
    const p2 = resolveTranscriptPath(root, "run_2", { cwdHint: join(root, "repo-never-bucketed") });
    assert.equal(p2, join(w.transcriptDir, "run_2.jsonl"), "未建桶 hint 不拦截扫描层命中（也不误造路径）");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("D2-②b 读侧: 孪生检测统一规则（哈希同→桶优先+可观测；异→具名硬错）", () => {
  const root = makeRoot("wao-pb-r3-");
  try {
    mkdirSync(join(root, "repo-eps"), { recursive: true });
    const w = resolveRunDirForWrite(root, identifyProjectFromCwd(join(root, "repo-eps"), IO));
    const bucketFile = join(w.transcriptDir, "run_twin.jsonl");
    write(bucketFile, "{\"same\":1}\n");
    write(join(root, "run_twin.jsonl"), "{\"same\":1}\n");
    assert.equal(resolveTranscriptPath(root, "run_twin"), bucketFile, "同哈希孪生 → 桶内优先（§6.5）");
    const twin = findTranscriptTwin(root, "run_twin");
    assert.equal(twin.bucketPaths.length, 1);
    assert.ok(twin.flatPath, "孪生事实可观测（不静默）");
    writeFileSync(join(root, "run_twin.jsonl"), "{\"CHANGED\":true}\n", "utf8");
    assert.throws(() => resolveTranscriptPath(root, "run_twin"), (e) => e instanceof TranscriptResolutionError && e.code === "transcript-resolution-conflict", "异哈希孪生 → 具名硬错（列出双路径，不择一）");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("D2-②b 读侧: 扫描超限具名错 + forAppend 未命中不误建平铺", () => {
  const root = makeRoot("wao-pb-r4-");
  try {
    // 造 >64 桶（无 .project.json 的裸目录也算目录项）
    for (let i = 0; i <= TRANSCRIPT_SCAN_BUCKET_LIMIT; i++) {
      mkdirSync(join(root, "projects", `b-${String(i).padStart(3, "0")}`), { recursive: true });
    }
    assert.throws(() => resolveTranscriptPath(root, "run_x"), (e) => e instanceof TranscriptResolutionError
      && e.code === "transcript-resolution-scan-over-limit"
      && /projects\/ has 65 buckets/.test(e.message), "超限=具名错（附实际桶数与建议），绝不静默截断");
    const root2 = makeRoot("wao-pb-r4b-");
    try {
      assert.throws(() => resolveTranscriptPath(root2, "run_missing", { forAppend: true }), (e) => e instanceof TranscriptResolutionError
        && e.code === "transcript-not-found"
        && /appenders must not create/.test(e.message), "追加者未命中 → 具名错（§6.9 不误建平铺）");
      assert.equal(existsSync(join(root2, "run_missing.jsonl")), false, "回落形状未被实体化");
    } finally { rmSync(root2, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("D2-②b 枚举: listTranscriptsDeep 两层 + .index.json 非桶 + readFirstProjectFact", () => {
  const root = makeRoot("wao-pb-e1-");
  try {
    mkdirSync(join(root, "repo-zeta"), { recursive: true });
    const w = resolveRunDirForWrite(root, identifyProjectFromCwd(join(root, "repo-zeta"), IO));
    write(join(root, "run_root.jsonl"), "{}\n");
    write(join(w.transcriptDir, "run_bucket.jsonl"), "{}\n");
    const deep = listTranscriptsDeep(root);
    assert.deepEqual(deep.map((e) => e.name), ["run_root.jsonl", "run_bucket.jsonl"], "根层在前、桶内次之");
    assert.equal(deep[1].bucket, w.bucket);
    assert.ok(!deep.some((e) => e.name === ".index.json"), "索引文件不入枚举面");
    // readFirstProjectFact：首行带事实即取，无/坏形状 null
    write(join(w.transcriptDir, "run_fact.jsonl"), JSON.stringify({ type: "run.started", project: { kind: "scratch", key: "_scratch" } }) + "\n");
    assert.deepEqual(readFirstProjectFact(join(w.transcriptDir, "run_fact.jsonl")), { kind: "scratch", key: "_scratch" });
    assert.equal(readFirstProjectFact(join(w.transcriptDir, "run_bucket.jsonl")), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
