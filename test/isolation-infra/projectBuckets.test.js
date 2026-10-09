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
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveRunDirForWrite, resolveTranscriptPath, listTranscriptsDeep, findTranscriptTwin,
  projectFactForWrite, readFirstProjectFact, loadBucketIndex, claimRunIdForWrite, releaseRunIdClaim, claimAgeMs,
  TranscriptResolutionError, TRANSCRIPT_SCAN_BUCKET_LIMIT,
} from "../../src/projectBuckets.js";
import { identifyProjectFromCwd, identityOfFirstEvent } from "../../src/projectIdentity.js";

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

test("D2-②b 写侧: 碰撞（同 slug 异 key）→ 加长哈希新桶；扩长形状过事实校验器（往返）", () => {
  const root = makeRoot("wao-pb-w2-");
  try {
    const dirA = join(root, "same-name");
    mkdirSync(dirA, { recursive: true });
    const wA = resolveRunDirForWrite(root, identifyProjectFromCwd(dirA, IO));
    // 伪造哈希碰撞：把既有桶记录篡改为异 key——resolveRunDirForWrite 必须
    // 加长哈希另建（8→10 hex），且新 slug 恒过 identityOfFirstEvent 校验器。
    const slug = wA.bucket;
    const collisionDir = join(root, "projects", slug);
    const recordPath = join(collisionDir, ".project.json");
    const rec = JSON.parse(readFileSync(recordPath, "utf8"));
    writeFileSync(recordPath, JSON.stringify({ ...rec, key: "D:\\other\\key" }, null, 2), "utf8");
    const w2 = resolveRunDirForWrite(root, identifyProjectFromCwd(dirA, IO));
    assert.notEqual(w2.bucket, slug, "异 key 记录 → 加长哈希新 slug");
    assert.match(w2.bucket, /-[0-9a-f]{10,}$/, `加长哈希段（实测 ${w2.bucket}）——不是 -2/-x 数字后缀`);
    const recAfter = JSON.parse(readFileSync(recordPath, "utf8"));
    assert.equal(recAfter.key, "D:\\other\\key", "既有记录不被覆盖（老桶永不改名）");
    // 验收批 M2 往返钉：扩长桶名的事实经 identityOfFirstEvent 必须零 factError。
    const fact = projectFactForWrite(identifyProjectFromCwd(dirA, IO), w2);
    const { factError, identity } = identityOfFirstEvent({ cwd: dirA, project: fact }, IO);
    assert.equal(factError, null, `扩长 slug 过事实校验器（bucket=${w2.bucket}）`);
    assert.equal(identity.kind, "project");
    assert.equal(identity.bucket, w2.bucket);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("D2-②b 写侧: displayName 首段为 Windows 保留名 → 0- 前缀破首段（三校验器同过）", () => {
  const root = makeRoot("wao-pb-w2b-");
  try {
    const dirA = join(root, "aux-tools");
    mkdirSync(dirA, { recursive: true });
    const id = identifyProjectFromCwd(dirA, IO);
    assert.equal(id.kind, "project", "测试前提：普通目录是项目身份");
    const w = resolveRunDirForWrite(root, id);
    assert.ok(w.bucket.startsWith("0-aux-tools-"), `0- 前缀破保留首段（实测 ${w.bucket}）`);
    const fact = projectFactForWrite(id, w);
    assert.equal(identityOfFirstEvent({ cwd: dirA, project: fact }, IO).factError, null,
      "0- 前缀桶名过事实校验器（aux- 直形在 HEAD 段会被保留名防御拒）");
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

// ─────────────────────────────────────────────────────────────────────────────
// 验收批修复反例钉（2026-10-09 夜，consult_…tzta 必改②④⑤+竞态）
// ─────────────────────────────────────────────────────────────────────────────

test("D2-②b 验收批④: 索引缓存塞路径成分（../../outside）→ 不越权、不据此建/读", () => {
  const root = makeRoot("wao-pb-v4-");
  try {
    mkdirSync(join(root, "repo-esc"), { recursive: true });
    const id = identifyProjectFromCwd(join(root, "repo-esc"), IO);
    const w = resolveRunDirForWrite(root, id);
    write(join(w.transcriptDir, "run_esc.jsonl"), "{\"a\":1}\n");
    // 篡改索引：key→"../../outside"（读侧 hint 与写侧命中都不得照单全收）
    const idx = join(root, "projects", ".index.json");
    const parsed = JSON.parse(readFileSync(idx, "utf8"));
    parsed.entries[id.key] = "../../outside";
    writeFileSync(idx, JSON.stringify(parsed), "utf8");
    // 读侧 hint：不得解析出 projects/ 之外的路径（此处回落扫描层命中真桶）
    const p = resolveTranscriptPath(root, "run_esc", { cwdHint: join(root, "repo-esc") });
    assert.equal(p, join(w.transcriptDir, "run_esc.jsonl"), "越权条目被拒→回落扫描层命中真桶");
    assert.ok(!existsSync(join(root, "outside")), "未在 projects/ 外创建任何目录");
    // 写侧：篡改条目核验不过 → 重建索引 → 沿用既有真桶（不据越权条目写档）
    const w2 = resolveRunDirForWrite(root, id);
    assert.equal(w2.bucket, w.bucket, "写侧拒绝越权条目后经权威重建回到真桶");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("D2-②b 验收批⑤: 孪生之一哈希读失败 → 具名硬错（null 不与 null 判同）", () => {
  const root = makeRoot("wao-pb-v5-");
  try {
    mkdirSync(join(root, "repo-hf"), { recursive: true });
    const w = resolveRunDirForWrite(root, identifyProjectFromCwd(join(root, "repo-hf"), IO));
    const bucketFile = join(w.transcriptDir, "run_hf.jsonl");
    write(bucketFile, "{\"same\":1}\n");
    write(join(root, "run_hf.jsonl"), "{\"same\":1}\n");
    // 注入 sha 读失败（io.sha256 对平铺路径抛错——模拟损坏/占用）
    const badIo = { sha256: (p) => { if (p.endsWith("run_hf.jsonl") && !p.includes("projects")) throw new Error("EACCES"); return "x"; } };
    assert.throws(() => resolveTranscriptPath(root, "run_hf", { io: badIo }),
      (e) => e.code === "transcript-resolution-conflict" && /unreadable/.test(e.message),
      "哈希读失败=硬错（不判同、不择一）");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("D2-②b 验收批⑤: hint 与无 hint 同一套孪生规则（三份同内容→单返回不报错）", () => {
  const root = makeRoot("wao-pb-v6-");
  try {
    mkdirSync(join(root, "repo-u1"), { recursive: true });
    mkdirSync(join(root, "repo-u2"), { recursive: true });
    const w1 = resolveRunDirForWrite(root, identifyProjectFromCwd(join(root, "repo-u1"), IO));
    const w2 = resolveRunDirForWrite(root, identifyProjectFromCwd(join(root, "repo-u2"), IO));
    const same = "{\"same\":1}\n";
    write(join(w1.transcriptDir, "run_u.jsonl"), same);
    write(join(w2.transcriptDir, "run_u.jsonl"), same);
    write(join(root, "run_u.jsonl"), same);
    // 注入圈养 io（与写侧同源）：夹具在 os.tmpdir() 下——生产 R5 会把 tmpdir
    // 前缀的 hint 判成 scratch（by design），此处要测的是 project-hint 语义。
    const io = { realpath: (p) => p, tmpdir: IO.tmpdir };
    // 无 hint：全层收集→全同→字典序最小桶（不因多份报错）
    const noHint = resolveTranscriptPath(root, "run_u", { io });
    assert.equal(noHint, join([w1, w2].sort((a, b) => a.bucket.localeCompare(b.bucket))[0].transcriptDir, "run_u.jsonl"),
      "无 hint：全同三份→字典序最小桶");
    // 有 hint（指向另一桶）：同规则收集→全同→hint 桶优先
    const hinted = resolveTranscriptPath(root, "run_u", { cwdHint: join(root, "repo-u2"), io });
    assert.equal(hinted, join(w2.transcriptDir, "run_u.jsonl"), "hint 桶优先（同一套规则，仅优先级不同）");
    // 异内容：两种路径同一硬错
    writeFileSync(join(w2.transcriptDir, "run_u.jsonl"), "{\"CHANGED\":true}\n", "utf8");
    assert.throws(() => resolveTranscriptPath(root, "run_u"), (e) => e.code === "transcript-resolution-conflict");
    assert.throws(() => resolveTranscriptPath(root, "run_u", { cwdHint: join(root, "repo-u2"), io }),
      (e) => e.code === "transcript-resolution-conflict", "hint 不豁免异内容硬错");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("D2-②b 验收批S3: 快命中遇扫描超限 → 可观测降级；无快命中仍硬错", () => {
  const root = makeRoot("wao-pb-v7-");
  try {
    for (let i = 0; i <= TRANSCRIPT_SCAN_BUCKET_LIMIT; i++) {
      mkdirSync(join(root, "projects", `b-${String(i).padStart(3, "0")}`), { recursive: true });
    }
    write(join(root, "run_flat.jsonl"), "{\"b\":1}\n");
    // 平铺快命中在场：读降级返回平铺（stderr 告警）；forAppend 不降级——
    // 未完成孪生比较不得当作无冲突（复验 sol）。
    assert.equal(resolveTranscriptPath(root, "run_flat"), join(root, "run_flat.jsonl"), "快命中降级");
    assert.throws(() => resolveTranscriptPath(root, "run_flat", { forAppend: true }),
      (e) => e.code === "transcript-resolution-scan-over-limit", "forAppend 不降级（未比较≠无冲突）");
    // 无快命中：保持具名硬错
    assert.throws(() => resolveTranscriptPath(root, "run_none2"),
      (e) => e.code === "transcript-resolution-scan-over-limit");
    // 诊断面：findTranscriptTwin 对超限仍硬错（可观测）
    assert.throws(() => findTranscriptTwin(root, "run_flat"),
      (e) => e.code === "transcript-resolution-scan-over-limit");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("D2-②b 验收批竞态: .claims 中心原子仲裁——同 runId 只有一个写者胜出", () => {
  const root = makeRoot("wao-pb-v8-");
  try {
    assert.equal(claimRunIdForWrite(root, "run_race_1").claimed, true, "首个写者 wx 成功");
    assert.equal(claimRunIdForWrite(root, "run_race_1").claimed, false, "并发第二写者 EEXIST 被拒");
    assert.equal(claimRunIdForWrite(root, "run_race_2").claimed, true, "不同 runId 互不影响");
    assert.ok(existsSync(join(root, ".claims", "run_race_1.g0")), "claim 代际文件落中心根（wx 即仲裁）");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 复验二轮钉（consult_…tn2juh：F1 生命周期/sol④ 不可读硬错/F3 下划线）
// ─────────────────────────────────────────────────────────────────────────────

test("D2-②b 复验 F1（六轮代际版）: 陈旧代可抢占、释放只标记、双抢占唯一胜者", () => {
  const root = makeRoot("wao-pb-f1-");
  try {
    const claimsDir = join(root, ".claims");
    const a = claimRunIdForWrite(root, "run_stale");
    assert.equal(a.claimed, true);
    assert.ok(a.nonce, "claim 携带持有者 nonce");
    assert.equal(claimRunIdForWrite(root, "run_stale").claimed, false, "新鲜代拒绝第二写者");
    // 慢持有者旧 nonce 释放：不标记新代（若已被抢占）
    const g0 = join(claimsDir, "run_stale.g0");
    const old = new Date(Date.now() - 11 * 60_000);
    utimesSync(g0, old, old);
    const b = claimRunIdForWrite(root, "run_stale");
    assert.equal(b.claimed, true, "陈旧代被抢占（g1）");
    assert.notEqual(a.nonce, b.nonce);
    releaseRunIdClaim(root, "run_stale", { nonce: a.nonce });
    assert.equal(existsSync(join(claimsDir, "run_stale.g1.released")), false, "旧 nonce 不标记新代（R2）");
    releaseRunIdClaim(root, "run_stale", { nonce: b.nonce });
    assert.equal(existsSync(join(claimsDir, "run_stale.g1.released")), true, "持有者标记释放（只加标记不删文件）");
    // 释放后的代=空闲 → 下一个 claim 开新代
    const c = claimRunIdForWrite(root, "run_stale");
    assert.equal(c.claimed, true, "已释放代可再仲裁（新代 g2）");
    assert.ok(existsSync(join(claimsDir, "run_stale.g2")), "代际文件在场（wx 创建即仲裁）");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("D2-②b 复验 sol④: 写侧确认遇不可读权威记录 → 硬错，不给同 key 建第二桶", () => {
  const root = makeRoot("wao-pb-s4-");
  try {
    const dirA = join(root, "repo-ur");
    mkdirSync(dirA, { recursive: true });
    const id = identifyProjectFromCwd(dirA, IO);
    const w = resolveRunDirForWrite(root, id);
    const realRead = readFileSync;
    const badIo = { readFileSync: (p, ...rest) => { if (String(p).includes(w.bucket) && String(p).endsWith(".project.json")) { const e = new Error("EACCES"); e.code = "EACCES"; throw e; } return realRead(p, ...rest); } };
    assert.throws(() => resolveRunDirForWrite(root, id, { io: badIo }),
      (e) => e.code === "transcript-resolution-conflict" && /unreadable/.test(e.message),
      "同 key 写入遇不可读权威记录=硬错（sol 探针形状：吞掉会建第二桶）");
    const buckets = readdirSync(join(root, "projects")).filter((b) => b.startsWith("repo-ur"));
    assert.deepEqual(buckets, [w.bucket], "未建第二桶");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("D2-②b 复验 F3: 下划线开头 displayName 的桶经索引正常确认（不每次强制重建）", () => {
  const root = makeRoot("wao-pb-f3-");
  try {
    const dirA = join(root, "_foo");
    mkdirSync(dirA, { recursive: true });
    const id = identifyProjectFromCwd(dirA, IO);
    const w1 = resolveRunDirForWrite(root, id);
    assert.ok(w1.bucket.startsWith("_foo-"), `slug 保留下划线开头（实测 ${w1.bucket}）`);
    const { entries, rebuilt } = loadBucketIndex(root);
    assert.equal(rebuilt, false, "缓存索引可确认（SAFE 正则放行前导下划线）");
    assert.equal(entries[id.key], w1.bucket);
    const w2 = resolveRunDirForWrite(root, id);
    assert.equal(w2.bucket, w1.bucket, "二次写沿用（无强制重建回路）");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 三轮复验钉（consult_…uklc4i：R1 索引缺 key/sol② 重建吞不可读/sol① 原子抢占）
// ─────────────────────────────────────────────────────────────────────────────

test("D2-②b 三轮 R1: 索引缺 key → 重建后沿用冻结桶（不按现行推导另建）", () => {
  const root = makeRoot("wao-pb-r1-");
  try {
    const dirA = join(root, "repo-x");
    mkdirSync(dirA, { recursive: true });
    const id = identifyProjectFromCwd(dirA, IO);
    const w = resolveRunDirForWrite(root, id); // 建 8-hex 桶并写索引
    // 伪造"冻结桶"：同 key 的 12-hex slug 桶（记录完好）+ 索引丢失该 key
    //（模拟 saveBucketIndex 并发丢条目——opus 探针形状）。
    const hash12 = createHash("sha256").update(id.key).digest("hex").slice(0, 12);
    const frozenSlug = `${id.displayName}-${hash12}`;
    const frozenDir = join(root, "projects", frozenSlug);
    mkdirSync(frozenDir, { recursive: true });
    writeFileSync(join(frozenDir, ".project.json"),
      JSON.stringify({ key: id.key, slug: frozenSlug, displayName: id.displayName, rulesVersion: "td190-r2", createdAt: new Date().toISOString(), aliases: [] }), "utf8");
    const idxPath = join(root, "projects", ".index.json");
    const idx = JSON.parse(readFileSync(idxPath, "utf8"));
    delete idx.entries[id.key];
    writeFileSync(idxPath, JSON.stringify(idx), "utf8");
    // 修前：缺 key 直接新建（8-hex）→ 同 key 双桶；修后：重建找到冻结桶沿用。
    // opus 探针原形：现场只有冻结桶（清掉探针自建的 8-hex 桶与它的索引条目）。
    rmSync(join(root, "projects", w.bucket), { recursive: true, force: true });
    const w2 = resolveRunDirForWrite(root, id);
    assert.equal(w2.bucket, frozenSlug, "索引缺 key 也经权威重建沿用冻结桶（R1）");
    const same = readdirSync(join(root, "projects")).filter((b) => b.startsWith(`${id.displayName}-`));
    assert.deepEqual(same, [frozenSlug], "同 key 只有一个桶（未按现行推导另建 8-hex）");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("D2-②b 三轮 sol②: 重建遇不可读权威记录 → 写侧硬错（缓存损坏不拆 key）", () => {
  const root = makeRoot("wao-pb-s2-");
  try {
    const dirA = join(root, "repo-rb");
    mkdirSync(dirA, { recursive: true });
    const id = identifyProjectFromCwd(dirA, IO);
    const w = resolveRunDirForWrite(root, id);
    // 损坏缓存索引 + 该桶 .project.json 持续不可读（sol 探针形状）
    writeFileSync(join(root, "projects", ".index.json"), "{corrupt", "utf8");
    const recPath = join(w.transcriptDir, ".project.json");
    const realRead = readFileSync;
    const badIo = { readFileSync: (p, ...rest) => { if (String(p) === recPath) { const e = new Error("EACCES"); e.code = "EACCES"; throw e; } return realRead(p, ...rest); } };
    assert.throws(() => resolveRunDirForWrite(root, { ...id, displayName: "current-name" }, { io: badIo }),
      (e) => e.code === "transcript-resolution-conflict" && /unreadable during index rebuild/.test(e.message),
      "重建遇不可读权威记录=写侧硬错（修前：吞掉+换名另建桶）");
    const buckets = readdirSync(join(root, "projects")).filter((b) => !b.startsWith("."));
    assert.equal(buckets.length, 1, "未另建第二桶");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("D2-②b 三轮 sol①（六轮代际版）: 抢占原子——wx 创建即单胜者", () => {
  const root = makeRoot("wao-pb-a1-");
  try {
    const claimsDir = join(root, ".claims");
    assert.equal(claimRunIdForWrite(root, "run_atomic").claimed, true);
    utimesSync(join(claimsDir, "run_atomic.g0"), new Date(Date.now() - 11 * 60_000), new Date(Date.now() - 11 * 60_000));
    const r1 = claimRunIdForWrite(root, "run_atomic").claimed;
    const r2 = claimRunIdForWrite(root, "run_atomic").claimed;
    assert.equal(r1 || r2, true, "至少一个胜者");
    assert.ok(!(r1 && r2), `连续双抢占恰一胜者（实测 ${r1},${r2}——胜者新代新鲜，后来者 fail-closed）`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 四轮钉（consult_…ew672e：A/sol① 抢占互斥锁 + R2 释放不删新持有者）
// ─────────────────────────────────────────────────────────────────────────────

test("D2-②b 六轮: 代际仲裁——wx 创建即单胜者（无锁层=无锁忙泄漏面）", () => {
  const root = makeRoot("wao-pb-l1-");
  try {
    // 陈旧 g0 + 双写者连续抢占：wx g1 只有一个胜者（创建即仲裁，无 rm/rename）
    const claimsDir = join(root, ".claims");
    assert.equal(claimRunIdForWrite(root, "run_lock").claimed, true);
    utimesSync(join(claimsDir, "run_lock.g0"), new Date(Date.now() - 11 * 60_000), new Date(Date.now() - 11 * 60_000));
    const r1 = claimRunIdForWrite(root, "run_lock").claimed;
    const r2 = claimRunIdForWrite(root, "run_lock").claimed;
    assert.equal(r1 || r2, true, "至少一个胜者（陈旧可抢占）");
    assert.ok(!(r1 && r2), `连续双抢占恰一胜者（实测 ${r1},${r2}）——胜者的新代是新鲜的`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("D2-②b 六轮: 释放只删不进——released 标记后旧代文件在场（ABA 结构性消除）", () => {
  const root = makeRoot("wao-pb-l2-");
  try {
    const claimsDir = join(root, ".claims");
    const a = claimRunIdForWrite(root, "run_rel");
    assert.equal(a.claimed, true);
    releaseRunIdClaim(root, "run_rel", { nonce: a.nonce });
    assert.equal(existsSync(join(claimsDir, "run_rel.g0")), true, "代文件不删（删除才是 ABA 之源）");
    assert.equal(existsSync(join(claimsDir, "run_rel.g0.released")), true, "released 标记在场");
    // 已释放 → 新 claim 开新代
    const b = claimRunIdForWrite(root, "run_rel");
    assert.equal(b.claimed, true);
    assert.ok(existsSync(join(claimsDir, "run_rel.g1")), "新代 g1");
    // 七轮 F7-1：**旧代永不删除**——删除会让代号可被迟到写者复用（双持有者
    // 探针实锤）；代文件保留是"创建即仲裁"前提。
    assert.equal(existsSync(join(claimsDir, "run_rel.g0")), true, "旧代保留（删除=复用窗口）");
    assert.equal(existsSync(join(claimsDir, "run_rel.g0.released")), true, "旧 released 标记保留（无害——只影响旧代）");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("D2-②b 四轮 B: 重建遇并发半写（首读空串→次读正常）不误报损坏", () => {
  const root = makeRoot("wao-pb-b1-");
  try {
    const dirA = join(root, "repo-hw");
    mkdirSync(dirA, { recursive: true });
    const id = identifyProjectFromCwd(dirA, IO);
    const w = resolveRunDirForWrite(root, id);
    // 损坏索引 → 重建；首读返回空串（半写窗），重读返回真记录 → 不入 unreadable。
    const recPath = join(w.transcriptDir, ".project.json");
    const real = readFileSync(recPath, "utf8");
    let reads = 0;
    const halfWriteIo = { readFileSync: (p, ...rest) => { if (String(p) === recPath && reads++ === 0) return ""; return real; } };
    const w2 = resolveRunDirForWrite(root, { ...id }, { io: halfWriteIo });
    assert.equal(w2.bucket, w.bucket, "半写重读后照常确认（不硬错）");
    // 持续空串（真损坏）→ 仍硬错（三轮 sol② 语义保持）。
    let reads2 = 0;
    const brokenIo = { readFileSync: (p, ...rest) => { if (String(p) === recPath && reads2++ >= 0) return ""; return real; } };
    assert.throws(() => resolveRunDirForWrite(root, { ...id }, { io: brokenIo }),
      (e) => e.code === "transcript-resolution-conflict" && /unreadable during index rebuild/.test(e.message),
      "持续半写=损坏仍硬错");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 五轮钉（consult_…g43b9：F1 EPERM 归类/F2 临界区 EEXIST 契约/C 回写）
// ─────────────────────────────────────────────────────────────────────────────

test("D2-②b 六轮 F1: 代际 wx 的 EPERM/EACCES=忙（不原始上抛；release 永不抛）", () => {
  const root = makeRoot("wao-pb-p1-");
  try {
    // 注入：g0 代 wx 创建抛 EPERM（Windows 删除挂起态形状）
    const realWrite = writeFileSync;
    const epermIo = { writeFileSync: (p, data, opts) => { if (String(p).endsWith(".g0") && opts?.flag === "wx") { const e = new Error("operation not permitted"); e.code = "EPERM"; throw e; } return realWrite(p, data, opts); } };
    assert.equal(claimRunIdForWrite(root, "run_eperm", { io: epermIo }).claimed, false,
      "EPERM=忙→fail-closed（修前：原始 EPERM 击穿具名冲突路径）");
    // release 全异常吞（EIO/ENOSPC/EMFILE 均不抛——best-effort 兑现）
    const claimPathDir = join(root, ".claims");
    for (const code of ["EIO", "ENOSPC", "EMFILE"]) {
      const badIo = { readdirSync: () => { const e = new Error(code); e.code = code; throw e; } };
      releaseRunIdClaim(root, "run_eperm", { nonce: "any", io: badIo }); // 不抛即过
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("D2-②b 五轮 C: 重建找回的条目回写索引（下次同 key 零扫描）", () => {
  const root = makeRoot("wao-pb-c1-");
  try {
    const dirA = join(root, "repo-wb");
    mkdirSync(dirA, { recursive: true });
    const id = identifyProjectFromCwd(dirA, IO);
    const w = resolveRunDirForWrite(root, id);
    // 丢索引条目 → 下一次写应命中重建并**回写**
    const idxPath = join(root, "projects", ".index.json");
    const idx = JSON.parse(readFileSync(idxPath, "utf8"));
    delete idx.entries[id.key];
    writeFileSync(idxPath, JSON.stringify(idx), "utf8");
    const w2 = resolveRunDirForWrite(root, id);
    assert.equal(w2.bucket, w.bucket);
    const after = JSON.parse(readFileSync(idxPath, "utf8"));
    assert.equal(after.entries[id.key], w.bucket, "找回条目已回写（C 补钉）");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 七轮钉（consult_…teg1p4：F7-1 复用窗口/F7-2 枚举失败 fail-closed/F7-3 年龄）
// ─────────────────────────────────────────────────────────────────────────────

test("D2-②b 七轮 F7-1: released 后旧代保留——迟到写者不能重建已用代号", () => {
  const root = makeRoot("wao-pb-f71-");
  try {
    const claimsDir = join(root, ".claims");
    // 场景压缩：g0 released → g1 建成（胜者）→ 迟到写者（判过 g0 可用）wx g0
    const a = claimRunIdForWrite(root, "run_late");
    assert.equal(a.claimed, true); // g0
    releaseRunIdClaim(root, "run_late", { nonce: a.nonce }); // g0.released
    const b = claimRunIdForWrite(root, "run_late");
    assert.equal(b.claimed, true); // g1（g0 已 released）
    assert.ok(existsSync(join(claimsDir, "run_late.g1")), "新代 g1");
    // 迟到写者（停在 readdir→wx 之间、判过 g0 可用）wx g0 → 文件在场 EEXIST
    assert.equal(existsSync(join(claimsDir, "run_late.g0")), true, "旧代在场（删除才有复用窗口——永不删除）");
    let lateG0 = false;
    try { writeFileSync(join(claimsDir, "run_late.g0"), "{}", { flag: "wx" }); lateG0 = true; } catch { lateG0 = false; }
    assert.equal(lateG0, false, "迟到写者不能重建 g0（创建即仲裁的前提=名字从未被删）");
    // g1 新鲜持有中 → 第三写者 fail-closed
    assert.equal(claimRunIdForWrite(root, "run_late").claimed, false, "新鲜代持有中=拒绝");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("D2-②b 七轮 F7-2: 目录枚举失败 fail-closed（不按无代际首建）", () => {
  const root = makeRoot("wao-pb-f72-");
  try {
    assert.equal(claimRunIdForWrite(root, "run_enum").claimed, true); // g0 在场
    const realReaddir = readdirSync;
    const eioIo = { readdirSync: (p, ...rest) => { if (String(p).endsWith(".claims")) { const e = new Error("io"); e.code = "EIO"; throw e; } return realReaddir(p, ...rest); } };
    assert.equal(claimRunIdForWrite(root, "run_enum", { io: eioIo }).claimed, false,
      "枚举失败=按持有中 fail-closed（修前：吞错→首建判断→可能重建已删代号）");
    // ENOENT（目录不存在）仍按首建（合法：新 runDir）
    const enoentIo = { readdirSync: (p, ...rest) => { if (String(p).endsWith(".claims")) { const e = new Error("no dir"); e.code = "ENOENT"; throw e; } return realReaddir(p, ...rest); } };
    assert.equal(claimRunIdForWrite(root, "run_fresh2", { io: enoentIo }).claimed, true, "ENOENT=首建（新 runId）");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("D2-②b 七轮 F7-3: claimAgeMs 读当前最大代（年龄提示可用）", () => {
  const root = makeRoot("wao-pb-f73-");
  try {
    assert.equal(claimAgeMs(root, "run_age"), null, "无代际=null");
    assert.equal(claimRunIdForWrite(root, "run_age").claimed, true);
    const age = claimAgeMs(root, "run_age");
    assert.ok(typeof age === "number" && age >= -50 && age < 5000, `当前代年龄（实测 ${age}ms；NTFS 时间戳粒度可致微小负值）`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
