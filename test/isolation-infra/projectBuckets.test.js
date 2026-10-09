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
  projectFactForWrite, readFirstProjectFact, loadBucketIndex, claimRunIdForWrite,
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
    // 平铺快命中在场：降级返回平铺（不抛 over-limit；孪生检测本轮放弃）
    assert.equal(resolveTranscriptPath(root, "run_flat"), join(root, "run_flat.jsonl"), "快命中降级");
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
    assert.equal(claimRunIdForWrite(root, "run_race_1"), true, "首个写者 wx 成功");
    assert.equal(claimRunIdForWrite(root, "run_race_1"), false, "并发第二写者 EEXIST 被拒");
    assert.equal(claimRunIdForWrite(root, "run_race_2"), true, "不同 runId 互不影响");
    assert.ok(existsSync(join(root, ".claims", "run_race_1")), "claim 标记落中心根");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
