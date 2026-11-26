// test/application/ownerWorkerDetail.test.js
//
// 第 141a 批（决定 0131 §3）：Owner 看板的单 worker 详情接口 GET /api/worker 与产物接口
// GET /api/artifact，以及它们依赖的 Git 对象读取（ownerArtifact）与诊断/任务书两处共用的
// 小函数。
//
// 夹具纪律：运行目录、转录、会审组记录与一次性 Git 仓库全部建在 os.tmpdir() 下，绝不读仓库的
// runs/。读模型是真实的 createOwnerReadModel（经服务的缺省接线），Git 对象是临时仓库里的真实
// 提交；只有"超时 / 超限"这类真实环境里难造的失败才用注入的执行器。
//
// 覆盖面（每条声称对应一个能证伪它的用例）：
//   - 写代码：验证通过 / 失败 / 具名不可验证 / 正在验证；增删行与二进制；续修轮次与接续关系、
//     裁决结果；对象已不可用（仓库不明、提交不在仓库、交付事实矛盾）
//   - 会审：组内各席一行、结论分裂、席位缺席、几席已到与是否收齐；任务书跳过固定合同；被审
//     运行上能看到对应的会审
//   - 调研答复：脱敏、截断并写明截在哪里；生图：图片文件清单
//   - 产物接口：png / jpeg / webp 按魔数取到；SVG、伪装成 png 的文本、超限、提交号不符、
//     序号越界、候选提交换了以后旧提交号 / 序号都拒绝
//   - 隔离违规的新字段：物理越界有 escapedAt、词法越界没有；畸形值不回显
//   - 没有交付物；任务书缺失；活性 / 阶段（含"阶段未知"）；时长用发布快照时的同一个 now
//   - 守卫：无令牌 401、多余或重复参数 400、形状不对 400、不存在或不可用 404、只许 GET、
//     响应不含仓库 / 工作树 / 运行目录路径与未脱敏的秘密；路由集合是闭集

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { rmrfRetry } from "../_rmrfHelper.mjs";
import { createOwnerDashboardServer } from "../../src/ownerDashboardServer.js";
import { CONSULT_SEAT_CONTRACT_MARKER } from "../../src/application/consultService.js";
import { createOwnerReadModel } from "../../src/application/ownerReadModel.js";
import {
  OWNER_ANSWER_MAX_CHARS,
  OWNER_DELIVERABLE_KINDS,
  OWNER_DELIVERABLE_STATES,
  OWNER_DELIVERABLE_UNAVAILABLE_REASONS,
  OWNER_FILES_MAX,
  OWNER_PATH_WITHHELD,
  currentDelivery,
  projectWorkerDetail,
} from "../../src/application/ownerWorkerDetail.js";
import {
  OWNER_ARTIFACT_MAX_BYTES,
  createNumstatReader,
  readCommitImage,
  readDeliveryNumstat,
  runGitReadOnly,
  sniffImageContentType,
} from "../../src/application/ownerArtifact.js";
import { projectIsolationViolationFields, projectWorkdirEscapeFields } from "../../src/diagnosis.js";
import { headOfRedactedText } from "../../src/application/runActivityProjection.js";
import { createSecretRedactor } from "../../src/secretRedaction.js";

// ===== 常量与夹具 =====

const T0 = Date.parse("2026-11-24T10:00:00.000Z");
const NOW = Date.parse("2026-11-24T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const jsonl = (events) => `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;

/** 假令牌带 placeholder 字样（脱敏守卫认可的夹具写法）；形状规则能识别它。 */
const SHAPE_SECRET = "sk-placeholder0123456789";
/** 环境里的"确切"秘密值：服务端 env 注入，名字命中密钥名规则。 */
const EXACT_SECRET = "test-secret-exact-value-7788";
const SERVER_ENV = { OWNER_TEST_API_KEY: EXACT_SECRET };

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(24)]);
const WEBP_BYTES = Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.from([0x20, 0, 0, 0]), Buffer.from("WEBP", "latin1"), Buffer.alloc(24)]);
const HUGE_PNG = Buffer.concat([PNG_1X1.subarray(0, 8), Buffer.alloc(OWNER_ARTIFACT_MAX_BYTES + 1 - 8)]);
const FAKE_PNG_TEXT = "this is not really a png\n";
const SVG_TEXT = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>\n';

const git = (cwd, ...args) => execFileSync("git", args, {
  cwd,
  encoding: "utf8",
  env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" },
}).trim();

function putFiles(root, files) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, ...path.split("/"));
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
}

/** 临时仓库：基线提交 + 两个交付提交（第二个用来模拟"候选提交换了"）。 */
function makeRepo(base) {
  const repo = join(base, "alpha-repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "core.autocrlf", "false");
  putFiles(repo, { "src/a.js": "l1\nl2\nl3\nl4\n", "docs/keep.md": "keep\n" });
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  const baseCommit = git(repo, "rev-parse", "HEAD");

  git(repo, "checkout", "-q", "-b", "delivery-one");
  putFiles(repo, {
    "src/a.js": "l1\nL2\nl3\nl4\nl5\nl6\n",
    "docs/notes.md": "n1\nn2\n",
    "assets/logo.png": PNG_1X1,
    "assets/fake.png": FAKE_PNG_TEXT,
    "assets/icon.svg": SVG_TEXT,
    "assets/photo.jpg": JPEG_BYTES,
    "assets/pic.webp": WEBP_BYTES,
    "assets/huge.png": HUGE_PNG,
  });
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "delivery one");
  const deliveryOne = git(repo, "rev-parse", "HEAD");
  const filesOne = git(repo, "diff", "--name-only", baseCommit, deliveryOne).split("\n").sort();

  git(repo, "checkout", "-q", "-b", "delivery-two", baseCommit);
  putFiles(repo, { "assets/other.png": PNG_1X1, "docs/keep.md": "keep\nmore\n" });
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "delivery two");
  const deliveryTwo = git(repo, "rev-parse", "HEAD");
  const filesTwo = git(repo, "diff", "--name-only", baseCommit, deliveryTwo).split("\n").sort();
  git(repo, "checkout", "-q", "-b", "main-line", baseCommit);
  return { repo, baseCommit, deliveryOne, filesOne, deliveryTwo, filesTwo };
}

const ALPHA = (key) => ({ slug: "alpha-11111111", name: "alpha 项目", key });
const projectFact = (p) => ({ kind: "project", rulesVersion: "td190-r3", key: p.key, bucket: p.slug });

function makeStore(repoKey) {
  const base = mkdtempSync(join(tmpdir(), "wao-owner-worker-detail-"));
  const runDir = join(base, "runs");
  const alpha = ALPHA(repoKey ?? join(base, "alpha-repo"));
  const bucket = join(runDir, "projects", alpha.slug);
  mkdirSync(bucket, { recursive: true });
  writeFileSync(
    join(bucket, ".project.json"),
    JSON.stringify({ key: alpha.key, slug: alpha.slug, displayName: alpha.name, rulesVersion: "td190-r3", createdAt: iso(T0), aliases: [] }),
    "utf8",
  );
  return {
    base, runDir, alpha, bucket,
    write: (runId, events, dir = bucket) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${runId}.jsonl`), typeof events === "string" ? events : jsonl(events), "utf8");
    },
  };
}

/** 事件构造器：信封字段权威，载荷不能覆盖。 */
function builder(runId, { agentId = "glm-pro", at = T0 } = {}) {
  const events = [];
  let seq = 0;
  let clock = at;
  const b = {
    events,
    runId,
    clock(ms) { clock = ms; return b; },
    add(type, payload = {}) {
      seq += 1;
      events.push({ ...payload, seq, ts: iso(clock), type, runId, agentId });
      return b;
    },
  };
  return b;
}

/** 派发头：background_submitted → pending → run.started → prompt.sent。 */
function head(b, ctx, {
  at = T0, deliveryRequested = false, prompt = "# 标准运行\n正文", continuation = null, roleId = "coder",
  laneId = "glm-pro", taskType, project = ctx.alpha, worktree = true,
} = {}) {
  b.clock(at).add("run.background_submitted", {
    background: true,
    cwd: ctx.alpha.key,
    deliveryRequested,
    ...(project === null ? {} : { project: projectFact(project) }),
    ...(continuation ? { continuation: true, parentRunId: continuation.parentRunId, rootRunId: continuation.rootRunId } : {}),
  });
  b.add("run.state_change", { from: null, to: "pending", reason: "background_spawned" });
  b.clock(at + 1000).add("run.started", {
    backend: "claude-code",
    cwd: ctx.alpha.key,
    ...(worktree ? { worktreePath: `${ctx.alpha.key}\\.wao-worktrees\\${b.runId}`, worktreeBranch: `wao/${b.runId}` } : {}),
    model: { id: "glm-5.3" },
    laneId,
    roleId,
    resolvedFrom: "explicit",
    ...(taskType ? { taskType } : {}),
  });
  if (prompt !== null) b.clock(at + 2000).add("prompt.sent", { prompt });
}

function working(b, at) {
  b.clock(at).add("session.created", { backend: "claude-code", backendSessionId: "proc_4242", serveUrl: null });
  b.add("run.submitted", {});
  b.add("run.state_change", { from: "pending", to: "submitted", reason: "spawned" });
  b.clock(at + 10).add("run.state_change", { from: "submitted", to: "running", reason: "first_event" });
}

const say = (b, at, textValue) => b.clock(at).add("run.event", {
  kind: "message", role: "assistant", parts: [{ type: "text", text: textValue }],
});

function terminal(b, at, state = "completed", error = "boom") {
  const fact = { completed: "run.completed", failed: "run.error", aborted: "run.aborted" }[state];
  b.clock(at).add(fact, state === "failed" ? { phase: "wait", error } : {});
  b.clock(at).add("run.state_change", { from: "running", to: state, reason: state });
}

/** 交付引用（形状取自 ownerReadModelFacts.test.js）。 */
function deliveryRef(runId, world, over = {}) {
  return {
    schemaVersion: 1,
    kind: "git_commit",
    runId,
    baseCommit: world.baseCommit,
    deliveryCommit: world.deliveryOne,
    branch: `wao/${runId}`,
    worktreePath: `${world.repo}\\.wao-worktrees\\${runId}`,
    changedFiles: world.filesOne,
    verification: { status: "pending", commands: ["npm test"], verifiedCommit: world.deliveryOne, results: [] },
    acceptance: { status: "pending", reviewerType: "lead_agent" },
    integration: { status: "pending", targetCommit: null },
    ...over,
  };
}

function verifiedRef(runId, world, status, over = {}) {
  const passedResult = { index: 0, command: "npm test", exitCode: 0, timedOut: false, durationMs: 4321, stdoutBytes: 12, stderrBytes: 0, stdoutTail: "", stderrTail: "" };
  const failedResult = { ...passedResult, exitCode: 1, durationMs: 777, stderrBytes: 30, stderrTail: `token ${SHAPE_SECRET}` };
  const verification = {
    passed: { status, commands: ["npm test"], results: [passedResult], verifiedCommit: world.deliveryOne },
    failed: {
      status, commands: ["npm test"], results: [failedResult], verifiedCommit: world.deliveryOne,
      failureCode: "command_failed", failedPhase: "assertion", failedCommandIndex: 0,
    },
    unavailable: { status, unavailableReason: "no runnable verification", commands: [], results: [], verifiedCommit: world.deliveryOne },
  }[status];
  return deliveryRef(runId, world, { verification, ...over });
}

const created = (b, at, world, over) => b.clock(at).add("run.delivery_created", { delivery: deliveryRef(b.runId, world, over) });
const outcome = (b, at, world, status, over) => b.clock(at).add(`run.delivery_verification_${status}`, {
  delivery: verifiedRef(b.runId, world, status, over),
});
const decide = (b, at, world, kind) => b.clock(at).add(`run.delivery_${kind}`, {
  delivery: verifiedRef(b.runId, world, "passed", { acceptance: { status: kind, reviewerType: "lead_agent" } }),
  deliveryCommit: world.deliveryOne,
  reason: "lead decision",
});

/** 已请求交付、已终态、已验证（passed）的运行事件；调用方可继续追加。 */
function deliveredRun(runId, world, ctx, o = {}) {
  const b = builder(runId);
  head(b, ctx, { deliveryRequested: true, prompt: `# ${o.title ?? "订单迁移"}\n任务正文 ${SHAPE_SECRET}`, ...o.head });
  working(b, T0 + 3000);
  say(b, T0 + 4000, "实现完成");
  terminal(b, T0 + 5000);
  created(b, T0 + 6000, world, o.createdOver);
  outcome(b, T0 + 7000, world, o.status ?? "passed", o.outcomeOver);
  return b;
}

// ===== 假 req/res（能收二进制） =====

async function drive(handler, { method = "GET", url = "/", headers = {} } = {}) {
  const req = { method, url, headers: { ...headers } };
  const state = { statusCode: 200, headers: {}, chunks: [] };
  const res = {
    setHeader(k, v) { state.headers[String(k).toLowerCase()] = v; },
    writeHead(status) { state.statusCode = status; },
    write(chunk) { state.chunks.push(Buffer.from(chunk)); },
    end(chunk) { if (chunk !== undefined) this.write(chunk); },
    getHeader(k) { return state.headers[String(k).toLowerCase()]; },
  };
  await handler(req, res);
  const bytes = Buffer.concat(state.chunks);
  return { status: state.statusCode, headers: state.headers, bytes, body: bytes.toString("utf8") };
}
const jsonOf = (r) => JSON.parse(r.body);

// ===== 世界：一个运行目录、一个临时仓库、一台真实读模型的服务 =====

let W; // 共享世界（只读用例共用）

async function buildWorld() {
  const base = mkdtempSync(join(tmpdir(), "wao-owner-worker-repo-"));
  const world = { base, ...makeRepo(base) };
  const s = makeStore(world.repo);
  const ctx = { alpha: s.alpha };
  Object.assign(world, { store: s, ctx });

  // —— 写代码：验证通过、等裁决 ——
  s.write("run_code_pass", deliveredRun("run_code_pass", world, ctx, {
    title: "Migrate orders",
    createdOver: undefined,
  }).events);
  // 验证失败 / 具名不可验证 / 正在验证（只有显式 pending 的 created）。
  s.write("run_code_fail", deliveredRun("run_code_fail", world, ctx, { status: "failed" }).events);
  s.write("run_code_unavail", deliveredRun("run_code_unavail", world, ctx, { status: "unavailable" }).events);
  {
    const b = builder("run_code_pending");
    head(b, ctx, { deliveryRequested: true });
    working(b, T0 + 3000);
    terminal(b, T0 + 5000);
    created(b, T0 + 6000, world);
    s.write("run_code_pending", b.events);
  }
  // —— 续修：第 1 轮被拒收，第 2 轮接续它并被采纳 ——
  {
    const r1 = deliveredRun("run_round_1", world, ctx, { title: "订单迁移" });
    decide(r1, T0 + 8000, world, "rejected");
    s.write("run_round_1", r1.events);
    const r2 = builder("run_round_2");
    head(r2, ctx, {
      at: T0 + 60_000, deliveryRequested: true, prompt: "会审判 FIX_FIRST，请据此修\n细节……",
      continuation: { parentRunId: "run_round_1", rootRunId: "run_round_1" },
    });
    working(r2, T0 + 63_000);
    terminal(r2, T0 + 65_000);
    created(r2, T0 + 66_000, world);
    outcome(r2, T0 + 67_000, world, "passed");
    decide(r2, T0 + 68_000, world, "accepted");
    s.write("run_round_2", r2.events);
  }
  // —— 生图：交付里有各种"图片" ——
  s.write("run_image", deliveredRun("run_image", world, ctx, { title: "出图", head: { taskType: "image", roleId: "coder" } }).events);
  // 候选提交换了的运行：一开始指向 delivery one，测试里改写成 delivery two。
  s.write("run_image_swap", deliveredRun("run_image_swap", world, ctx, { title: "出图（换候选）", head: { taskType: "image" } }).events);

  // —— 对象已不可用：仓库不明 / 提交不在仓库 / 事实矛盾 ——
  s.write("run_no_repo", deliveredRun("run_no_repo", world, ctx, { head: { project: null } }).events, s.runDir);
  const missing = "9".repeat(40);
  s.write("run_git_gone", deliveredRun("run_git_gone", world, ctx, {
    createdOver: { deliveryCommit: missing, verification: { status: "pending", commands: ["npm test"], verifiedCommit: missing, results: [] } },
    outcomeOver: { deliveryCommit: missing, verification: { status: "passed", commands: ["npm test"], verifiedCommit: missing, results: [{ index: 0, command: "npm test", exitCode: 0, timedOut: false, durationMs: 1 }] } },
  }).events);
  {
    const b = deliveredRun("run_conflict", world, ctx);
    created(b, T0 + 6500, world);
    s.write("run_conflict", b.events);
  }

  // —— 调研：短答复、超长答复（秘密跨在截断点上）、无答复 ——
  {
    const b = builder("run_research");
    head(b, ctx, { roleId: "researcher", prompt: "# 调研分页\n正文" });
    working(b, T0 + 3000);
    say(b, T0 + 4000, "先看了一遍");
    say(b, T0 + 4500, `结论：用游标分页。\n含秘密 ${SHAPE_SECRET} 与 ${EXACT_SECRET}。`);
    terminal(b, T0 + 5000);
    s.write("run_research", b.events);
  }
  {
    const b = builder("run_research_long");
    head(b, ctx, { roleId: "researcher", prompt: "# 长调研\n正文" });
    working(b, T0 + 3000);
    // 秘密正好跨在 64 KiB 的截断点上（原文里它从上限前 5 个字符处开始）：先脱敏再截断，
    // 截断点上不会留半截秘密。前面的空格让形状规则的词边界成立。
    say(b, T0 + 4000, `${"x".repeat(OWNER_ANSWER_MAX_CHARS - 6)} ${SHAPE_SECRET}${"y".repeat(5000)}`);
    terminal(b, T0 + 5000);
    s.write("run_research_long", b.events);
  }
  {
    const b = builder("run_research_none");
    head(b, ctx, { roleId: "researcher" });
    working(b, T0 + 3000);
    terminal(b, T0 + 5000);
    s.write("run_research_none", b.events);
  }

  // —— 会审：被审运行 = run_code_pass；三席（一席结论 PASS、一席 FIX_FIRST、一席缺席） ——
  const consultsDir = join(world.repo, ".wao", "runs", "consults");
  mkdirSync(consultsDir, { recursive: true });
  const seatPrompt = `# 会审任务书\n## Q1 是否可行\n视角：看边界${CONSULT_SEAT_CONTRACT_MARKER}你只负责逐问给出意见。`;
  const seatRun = (runId, agentId, reply, state = "completed") => {
    const b = builder(runId, { agentId });
    head(b, ctx, { roleId: "auditor", laneId: agentId, prompt: seatPrompt });
    working(b, T0 + 3000);
    say(b, T0 + 4000, reply);
    if (state !== "running") terminal(b, T0 + 5000, state);
    s.write(runId, b.events);
  };
  seatRun("run_seat_a", "sol", "## Q1: PASS\n\n理由。");
  seatRun("run_seat_b", "astra", "## Q1: FIX_FIRST\n\n要改。");
  const consultId = "consult_20261124120000001aaaaaa";
  writeFileSync(join(consultsDir, `${consultId}.json`), JSON.stringify({
    consultId,
    createdAt: iso(NOW - 3000),
    brief: { path: `${world.repo}\\briefs\\plan.md`, sha256: "a".repeat(64) },
    budgetMs: 0,
    elapsedMs: 5,
    reviewedRunId: "run_code_pass",
    questions: [{ q: 1, heading: "## Q1 是否可行" }],
    declaredFields: { Q1: ["PASS", "PASS_WITH_NOTES", "FIX_FIRST"] },
    seats: [
      { agentId: "sol", runId: "run_seat_a", runState: "completed", formatState: "structured" },
      { agentId: "astra", runId: "run_seat_b", runState: "completed", formatState: "structured" },
      { agentId: "kimi", runId: "run_seat_gone", runState: "running", formatState: "structured" },
    ],
    fieldDiff: [],
  }, null, 2), "utf8");
  world.consultId = consultId;

  // —— 隔离违规：物理越界（带 escapedAt）、词法越界（escapedAt 不给）、畸形值 ——
  const isolation = (runId, violation) => {
    const b = builder(runId);
    head(b, ctx, { deliveryRequested: true });
    working(b, T0 + 3000);
    terminal(b, T0 + 5000, "failed");
    b.clock(T0 + 6000).add("run.isolation_violation", { code: "workdir_escape", ...violation });
    s.write(runId, b.events);
  };
  isolation("run_iso_physical", {
    reason: "file_written_physical_outside", destination: "main_checkout",
    reportedPath: "..\\escape\\a.txt", resolvedPath: "D:\\outside\\main\\a.txt", escapedAt: "D:\\outside\\link",
  });
  isolation("run_iso_lexical", {
    reason: "file_written_lexical_outside", destination: "temp",
    reportedPath: "..\\escape\\b.txt", resolvedPath: "D:\\outside\\b.txt", escapedAt: "D:\\must\\not\\show",
  });
  isolation("run_iso_malformed", {
    reason: "hacked-reason", destination: "../../etc/passwd", reportedPath: 12345,
    resolvedPath: `D:\\x\u0007y\nz ${SHAPE_SECRET} ${"p".repeat(600)}`, escapedAt: { nested: true },
  });

  // —— 没有交付物 / 任务书缺失 / 活性与阶段 ——
  {
    const b = builder("run_wait_no_delivery");
    head(b, ctx, { deliveryRequested: true, prompt: null });
    working(b, NOW - 60_000);
    say(b, NOW - 10_000, "我已经把交付做完了（自述，不算）");
    s.write("run_wait_no_delivery", b.events);
  }
  {
    const b = builder("run_untyped");
    head(b, ctx, { roleId: "auditor" });
    working(b, T0 + 3000);
    say(b, T0 + 4000, "报告");
    terminal(b, T0 + 5000);
    s.write("run_untyped", b.events);
  }
  {
    const b = builder("run_silent");
    head(b, ctx, { at: NOW - 3_600_000 });
    working(b, NOW - 3_500_000);
    say(b, NOW - 3_400_000, "开了个头");
    s.write("run_silent", b.events);
  }
  {
    const b = builder("run_starting");
    b.clock(NOW - 45_000).add("run.background_submitted", { background: true, project: projectFact(ctx.alpha) });
    b.add("run.state_change", { from: null, to: "pending", reason: "background_spawned" });
    s.write("run_starting", b.events);
  }
  {
    const b = builder("run_nostage");
    b.clock(NOW - 5000).add("run.state_change", { from: null, to: "pending", reason: "background_spawned" });
    s.write("run_nostage", b.events);
  }
  // —— 不可用：坏转录、多份内容冲突 ——
  s.write("run_corrupt", "this is not json\n");
  s.write("run_dup", deliveredRun("run_dup", world, ctx).events);
  s.write("run_dup", `${jsonl(deliveredRun("run_dup", world, ctx, { title: "另一份" }).events)}`, s.runDir);

  let clock = NOW;
  const server = createOwnerDashboardServer({
    runDir: s.runDir,
    workspaceRoot: world.base,
    knownAgentIds: [],
    env: SERVER_ENV,
    nowFn: () => clock,
  });
  world.server = server;
  world.setClock = (value) => { clock = value; };
  world.auth = { authorization: `Bearer ${server.token}` };
  world.get = (url, headers = world.auth) => drive(server.handler, { url, headers });
  world.worker = async (runId) => jsonOf(await world.get(`/api/worker?runId=${runId}`));
  world.preRefresh = await drive(server.handler, { url: "/api/worker?runId=run_code_pass", headers: world.auth });
  assert.equal(await server.refreshNow(), "ready");
  return world;
}

before(async () => { W = await buildWorld(); });
after(async () => {
  await W.server.close();
  rmrfRetry(W.base);
});

/** 响应里不得出现的服务端私有串：仓库根、运行目录、临时根，以及它们在 JSON 里的转义写法。 */
function privateNeedles() {
  const raw = [W.repo, W.store.runDir, W.base];
  return [...raw, ...raw.map((p) => JSON.stringify(p).slice(1, -1))];
}
function assertSafeBody(response) {
  for (const needle of privateNeedles()) {
    assert.ok(!response.body.includes(needle), `响应泄漏了 ${needle}`);
  }
  for (const secret of [SHAPE_SECRET, EXACT_SECRET]) assert.ok(!response.body.includes(secret), `响应带着未脱敏的秘密 ${secret}`);
  assert.ok(!response.body.includes(W.server.token), "响应里没有令牌");
  assert.ok(!/worktreePath|deliveryRef|\.wao-worktrees/.test(response.body), "响应里没有工作树字段或路径");
}
function assertSafeHeaders(response) {
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.ok(!("access-control-allow-origin" in response.headers), "不开 CORS");
}

// ===== 1. 身份、健康、Run 轴 =====

test("写代码·验证通过：身份、健康、Run 轴、交付轴、交付物（提交、文件清单与增删行、验证命令与结果）", async () => {
  const response = await W.get("/api/worker?runId=run_code_pass");
  assert.equal(response.status, 200);
  assertSafeHeaders(response);
  assertSafeBody(response);
  const d = jsonOf(response);
  assert.equal(d.status, "ready");
  assert.equal(d.generatedAt, iso(NOW));
  assert.equal(d.runId, "run_code_pass");

  assert.deepEqual(d.identity, {
    title: "Migrate orders", subtitle: null, taskType: "code", laneKey: "glm-pro", roleId: "coder",
    project: { slug: "alpha-11111111", name: "alpha 项目" },
    startedAt: iso(T0 + 1000), elapsedMs: 4000, // 终态运行：终态时刻 − 开始时刻
  });
  assert.equal(d.health.liveness, "terminal");
  assert.equal(d.health.failure, null);
  assert.equal(d.run.state, "completed");
  assert.equal(d.run.stage, "terminal");

  assert.deepEqual(d.delivery.verification, { status: "passed", reverify: { status: "none", reason: null } });
  assert.deepEqual(d.delivery.settlement, { status: "settled", reason: "delivery_settled" });
  assert.equal(d.delivery.commit, W.deliveryOne);
  assert.equal(d.delivery.awaitingDecision, true, "收口、待裁决、没被取代");
  assert.deepEqual(d.delivery.decision, { result: null, decidedAt: null, supersededByRunId: null });
  assert.deepEqual(d.delivery.round, { number: 1, complete: true, rootRunId: "run_code_pass", continuesRunId: null, continuesDecision: null });

  const dv = d.deliverable;
  assert.equal(dv.kind, "code");
  assert.equal(dv.state, "bound");
  assert.equal(dv.reason, null);
  assert.deepEqual(dv.commit, { hash: W.deliveryOne, source: "system_observed" });
  assert.equal(dv.files.source, "system_observed");
  assert.equal(dv.files.total, W.filesOne.length);
  assert.equal(dv.files.truncated, false);
  assert.deepEqual(dv.files.items.map((f) => f.path), W.filesOne, "序号 = changedFiles 的下标，路径是仓库相对路径");
  const byPath = new Map(dv.files.items.map((f) => [f.path, f]));
  assert.deepEqual(byPath.get("src/a.js"), { index: W.filesOne.indexOf("src/a.js"), path: "src/a.js", added: 3, deleted: 1, binary: false });
  assert.deepEqual(byPath.get("docs/notes.md"), { index: W.filesOne.indexOf("docs/notes.md"), path: "docs/notes.md", added: 2, deleted: 0, binary: false });
  assert.deepEqual(byPath.get("assets/logo.png"), { index: W.filesOne.indexOf("assets/logo.png"), path: "assets/logo.png", added: null, deleted: null, binary: true }, "二进制文件写二进制");

  assert.equal(dv.verification.source, "system_observed");
  assert.equal(dv.verification.boundCommit, W.deliveryOne);
  assert.equal(dv.verification.status, "passed");
  assert.deepEqual(dv.verification.commands, [{ index: 0, command: "npm test", result: { exitCode: 0, timedOut: false, durationMs: 4321 } }]);
  assert.deepEqual(dv.verification.setupCommands, []);
  assert.equal(dv.verification.failure, null);
  assert.ok(Array.isArray(dv.reviews) && dv.reviews.length === 1, "被审运行上能看到对应的会审");

  assert.equal(d.brief.state, "present");
  assert.ok(d.brief.text.startsWith("# Migrate orders"));
  assert.ok(d.brief.text.includes("[REDACTED]"), "任务书里的秘密形状被脱敏");
  assert.equal(d.consult, null);
});

test("DTO 白名单：顶层与各块的键集固定，没有 deliveryRef / 工作树 / 仓库路径", async () => {
  const d = await W.worker("run_code_pass");
  assert.deepEqual(Object.keys(d).sort(), ["brief", "consult", "deliverable", "delivery", "generatedAt", "health", "identity", "run", "runId", "status"]);
  assert.deepEqual(Object.keys(d.identity).sort(), ["elapsedMs", "laneKey", "project", "roleId", "startedAt", "subtitle", "taskType", "title"]);
  assert.deepEqual(Object.keys(d.health).sort(), ["failure", "lastEffectAt", "lastProcessActiveAt", "lastVitalAt", "liveness"]);
  assert.deepEqual(Object.keys(d.run).sort(), ["stage", "stageAgeMs", "stageSince", "state", "terminalAt"]);
  assert.deepEqual(Object.keys(d.delivery).sort(), [
    "ambiguous", "awaitingDecision", "branchPresent", "commit", "decision", "isolationFailure", "packagingFailure", "round", "settledAt", "settlement", "verification",
  ]);
  assert.deepEqual(Object.keys(d.deliverable).sort(), ["commit", "files", "kind", "reason", "reviews", "state", "verification"]);
  assert.deepEqual(Object.keys(d.deliverable.verification).sort(), ["boundCommit", "commands", "failure", "setupCommands", "source", "status"]);
  assert.deepEqual(Object.keys(d.brief).sort(), ["keptChars", "state", "text", "totalChars", "truncated"]);
  assert.deepEqual(Object.keys(d.deliverable.files.items[0]).sort(), ["added", "binary", "deleted", "index", "path"]);
});

test("健康：有进展 / 静默（活性四值取自读模型）；已运行时长用发布快照时的同一个 now", async () => {
  const live = await W.worker("run_wait_no_delivery");
  assert.equal(live.health.liveness, "progress");
  assert.equal(live.health.lastEffectAt, iso(NOW - 10_000));
  assert.equal(live.identity.elapsedMs, NOW - (T0 + 1000), "非终态：发布时的 now − 开始时刻");
  const silent = await W.worker("run_silent");
  assert.equal(silent.health.liveness, "silent");
  assert.equal(silent.run.state, "running");
  assert.equal(silent.run.stage, "active");

  // 时钟走了，但没有新的发布：时长还是按发布时的 now 算（与列表同一个 now）。
  W.setClock(NOW + 3_600_000);
  try {
    const after = await W.worker("run_wait_no_delivery");
    assert.equal(after.identity.elapsedMs, live.identity.elapsedMs);
    assert.equal(after.generatedAt, iso(NOW));
  } finally {
    W.setClock(NOW);
  }
});

test("Run 轴：启动阶段有依据给阶段与年龄；没有阶段依据写 stage_unknown，不编造起点", async () => {
  const starting = await W.worker("run_starting");
  assert.equal(starting.run.state, "pending");
  assert.equal(starting.run.stage, "starting");
  assert.equal(starting.run.stageSince, iso(NOW - 45_000));
  assert.equal(starting.run.stageAgeMs, 45_000);
  const unknown = await W.worker("run_nostage");
  assert.equal(unknown.run.state, "pending");
  assert.equal(unknown.run.stage, "stage_unknown");
  assert.equal(unknown.run.stageSince, null);
  assert.equal(unknown.run.stageAgeMs, null);
});

// ===== 2. 交付轴与交付物：验证三态 + 正在验证 =====

test("写代码·验证失败：确证失败带闭集失败码、阶段与命令序号；命令的 stderr 尾部不出现在响应里", async () => {
  const response = await W.get("/api/worker?runId=run_code_fail");
  assertSafeBody(response); // 含 stderrTail 里的秘密形状
  const d = jsonOf(response);
  assert.equal(d.delivery.verification.status, "failed");
  assert.equal(d.deliverable.verification.status, "failed");
  assert.deepEqual(d.deliverable.verification.failure, { code: "command_failed", phase: "assertion", commandIndex: 0 });
  assert.deepEqual(d.deliverable.verification.commands[0].result, { exitCode: 1, timedOut: false, durationMs: 777 });
  assert.ok(!response.body.includes("stderrTail"), "不给命令输出");
});

test("写代码·具名不可验证 / 正在验证：状态如实给出，不当作通过", async () => {
  const unavailable = await W.worker("run_code_unavail");
  assert.equal(unavailable.deliverable.verification.status, "unavailable");
  assert.equal(unavailable.delivery.verification.status, "unavailable");
  assert.deepEqual(unavailable.deliverable.verification.commands, []);
  const pending = await W.worker("run_code_pending");
  assert.equal(pending.deliverable.verification.status, "pending", "只有 created、没有验证结果：正在验证");
  assert.deepEqual(pending.deliverable.verification.commands, [{ index: 0, command: "npm test", result: null }], "有声明的命令、还没有结果");
  assert.equal(pending.delivery.awaitingDecision, false, "验证没收口：不算在等裁决");
});

// ===== 3. 续修轮次、裁决结果 =====

test("续修轮次：第 N 轮、接续哪个 runId、上一轮的裁决；主标题取谱系根、本轮第一行作副标题；采纳 / 拒收结果", async () => {
  const second = await W.worker("run_round_2");
  assert.equal(second.identity.title, "订单迁移", "续修子运行的主标题取谱系根的标题");
  assert.equal(second.identity.subtitle, "会审判 FIX_FIRST，请据此修", "本轮任务书的第一行作副标题");
  assert.deepEqual(second.delivery.round, {
    number: 2, complete: true, rootRunId: "run_round_1", continuesRunId: "run_round_1", continuesDecision: "rejected",
  });
  assert.deepEqual(second.delivery.decision, { result: "accepted", decidedAt: iso(T0 + 68_000), supersededByRunId: null });
  assert.equal(second.delivery.awaitingDecision, false);
  const first = await W.worker("run_round_1");
  assert.equal(first.identity.subtitle, null);
  assert.equal(first.delivery.round.number, 1);
  assert.deepEqual(first.delivery.decision, { result: "rejected", decidedAt: iso(T0 + 8000), supersededByRunId: null });
  assert.equal(first.delivery.awaitingDecision, false);
});

test("projectWorkerDetail（纯投影）：被取代给 superseded、判不了的不下结论；轮次链断在快照之外 complete:false；成环不死循环", async () => {
  const row = (runId, over = {}) => ({
    runId, availability: "ok", state: "completed", terminal: true, liveness: "terminal", stage: "terminal",
    laneId: "glm-pro", agentId: "glm-pro", roleId: "coder", deliveryRequested: true, title: `T ${runId}`, taskType: "code",
    startedAt: iso(T0), terminalAt: iso(T0 + 1000), stageSince: iso(T0), lastEffectAt: null, lastVitalAt: null, lastProcessActiveAt: null,
    parentRunId: null, lineageRootRunId: runId, supersededByRunId: null, supersessionUndeterminable: false, project: null, failure: null,
    delivery: {
      settlement: { status: "settled", reason: "delivery_settled" }, commit: "c".repeat(40),
      verification: { status: "passed", reverify: { status: "none", reason: null } },
      acceptance: { status: "pending", decidedAt: null }, settledAt: iso(T0 + 1000), ambiguous: false,
      packagingFailure: null, isolationFailure: null, branchPresent: true,
    },
    ...over,
  });
  const run = async (target, rows, extra = {}) => projectWorkerDetail({
    run: target, snapshot: { generatedAt: iso(NOW), consults: [], runs: rows }, runsById: new Map(rows.map((r) => [r.runId, r])),
    events: [], now: NOW, ...extra,
  });

  const superseded = row("run_sup", { supersededByRunId: "run_next" });
  const d1 = await run(superseded, [superseded]);
  assert.equal(d1.delivery.decision.result, "superseded");
  assert.equal(d1.delivery.decision.supersededByRunId, "run_next");
  assert.equal(d1.delivery.awaitingDecision, false);

  const undeterminable = row("run_und", { supersessionUndeterminable: true });
  assert.equal((await run(undeterminable, [undeterminable])).delivery.awaitingDecision, null, "是否被取代没能判定：不下结论");

  const orphan = row("run_orphan", { parentRunId: "run_missing_parent" });
  const d3 = await run(orphan, [orphan]);
  assert.deepEqual([d3.delivery.round.number, d3.delivery.round.complete, d3.delivery.round.continuesDecision], [2, false, null]);

  const a = row("run_cycle_a", { parentRunId: "run_cycle_b" });
  const b = row("run_cycle_b", { parentRunId: "run_cycle_a" });
  const d4 = await run(a, [a, b]);
  assert.equal(d4.delivery.round.complete, false, "成环：停下来，不死循环");

  const undet = row("run_settle_und", { delivery: { ...row("x").delivery, settlement: { status: "undeterminable", reason: "delivery_facts_malformed" } } });
  assert.equal((await run(undet, [undet])).delivery.awaitingDecision, null);

  const none = await run(row("run_plain", { deliveryRequested: false, delivery: null }), []);
  assert.equal(none.delivery, null, "没请求交付就没有交付轴");
  assert.deepEqual(none.deliverable, { kind: "none", state: "none" });
});

// ===== 4. 会审 =====

test("会审：席位的会审轴（本席状态、几席已到、是否收齐）与交付物（每席一行、结论分裂、席位缺席）", async () => {
  const d = await W.worker("run_seat_a");
  assert.equal(d.identity.taskType, "untyped", "会审席本批仍按读模型的类型（旧席位 untyped）");
  assert.equal(d.identity.laneKey, "sol");
  assert.deepEqual(d.consult, {
    consultId: W.consultId, createdAt: iso(NOW - 3000), reviewedRunId: "run_code_pass",
    thisSeat: { agentId: "sol", runState: "completed" }, seatsTotal: 3, seatsArrived: 2, complete: false,
  });
  assert.equal(d.deliverable.kind, "consult");
  assert.equal(d.deliverable.state, "bound");
  assert.equal(d.deliverable.q1Declared, true);
  assert.equal(d.deliverable.split, true, "PASS 与 FIX_FIRST：结论分裂");
  assert.deepEqual(d.deliverable.rows, [
    { laneKey: "sol", agentId: "sol", runId: "run_seat_a", runState: "completed", q1: "PASS", source: "worker_reported" },
    { laneKey: "astra", agentId: "astra", runId: "run_seat_b", runState: "completed", q1: "FIX_FIRST", source: "worker_reported" },
    { laneKey: "kimi", agentId: "kimi", runId: "run_seat_gone", runState: "missing", q1: null, source: "worker_reported" },
  ], "缺席的席位如实 missing、结论留空");
  // 任务书：跳过会审席的固定合同包装，视角片段属于任务书。
  assert.equal(d.brief.state, "present");
  assert.ok(d.brief.text.includes("会审任务书") && d.brief.text.includes("视角：看边界"));
  assert.ok(!d.brief.text.includes("会审席边界") && !d.brief.text.includes("你只负责逐问"), "固定合同不进任务书");
});

test("会审：被审运行（写代码）的交付物里列出对应的交付会审各席结论", async () => {
  const d = await W.worker("run_code_pass");
  const [review] = d.deliverable.reviews;
  assert.equal(review.consultId, W.consultId);
  assert.equal(review.split, true);
  assert.deepEqual(review.rows.map((r) => [r.laneKey, r.q1]), [["sol", "PASS"], ["astra", "FIX_FIRST"], ["kimi", null]]);
});

// ===== 5. 调研答复 =====

test("调研答复：最后一条助手消息，exact 与形状两层脱敏；没有截断时 truncated:false", async () => {
  const response = await W.get("/api/worker?runId=run_research");
  assertSafeBody(response);
  const d = jsonOf(response);
  assert.equal(d.identity.taskType, "research");
  assert.equal(d.deliverable.kind, "research");
  assert.equal(d.deliverable.state, "bound");
  assert.equal(d.deliverable.answer.source, "worker_reported");
  assert.ok(d.deliverable.answer.text.startsWith("结论：用游标分页。"), "取最后一条助手消息，不是第一条");
  assert.ok(!d.deliverable.answer.text.includes("先看了一遍"));
  assert.ok(d.deliverable.answer.text.includes("[REDACTED"));
  assert.equal(d.deliverable.answer.truncated, false);
  assert.equal(d.deliverable.answer.keptChars, d.deliverable.answer.totalChars);
});

test("调研答复：超长答复在上限处截断并写明截在哪里；跨在截断点上的秘密先脱敏、不留半截", async () => {
  const response = await W.get("/api/worker?runId=run_research_long");
  assertSafeBody(response);
  const { answer } = jsonOf(response).deliverable;
  assert.equal(answer.truncated, true);
  assert.equal(answer.keptChars, OWNER_ANSWER_MAX_CHARS, "截在上限处");
  assert.equal(answer.text.length, OWNER_ANSWER_MAX_CHARS);
  assert.ok(answer.totalChars > OWNER_ANSWER_MAX_CHARS, "总长度照实给");
  assert.ok(!/sk-|placeholder/.test(answer.text), "截断点上没有半截秘密");
  assert.ok(answer.text.endsWith(" [REDA"), "脱敏后的占位在截断点上被截（原文里的秘密早已不在）");
});

test("调研：没有助手消息 → 尚未观测到交付物（state none，不按自述补）", async () => {
  const d = await W.worker("run_research_none");
  assert.deepEqual(d.deliverable, { kind: "research", state: "none", answer: null });
});

// ===== 6. 生图与产物接口 =====

test("生图：交付物带图片文件的序号与相对路径（只列产物接口取得到的类型：png / jpg / jpeg / webp）", async () => {
  const d = await W.worker("run_image");
  assert.equal(d.identity.taskType, "image");
  assert.equal(d.deliverable.kind, "image");
  assert.equal(d.deliverable.state, "bound");
  const expected = W.filesOne
    .map((path, index) => ({ index, path }))
    .filter((f) => /\.(png|jpg|jpeg|webp)$/.test(f.path));
  assert.deepEqual(d.deliverable.images, expected);
  assert.ok(!d.deliverable.images.some((f) => f.path.endsWith(".svg")), "SVG 不列");
  assert.ok(d.deliverable.files.items.length === W.filesOne.length, "文件清单照给");
});

const artifactUrl = (runId, commit, index) => `/api/artifact?runId=${runId}&commit=${commit}&fileIndex=${index}`;

test("产物接口：png / jpeg / webp 按魔数取到，响应头是判定的类型 + nosniff + no-store", async () => {
  for (const [path, type, bytes] of [
    ["assets/logo.png", "image/png", PNG_1X1],
    ["assets/photo.jpg", "image/jpeg", JPEG_BYTES],
    ["assets/pic.webp", "image/webp", WEBP_BYTES],
  ]) {
    const r = await W.get(artifactUrl("run_image", W.deliveryOne, W.filesOne.indexOf(path)));
    assert.equal(r.status, 200, path);
    assert.equal(r.headers["content-type"], type, path);
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert.equal(r.headers["cache-control"], "no-store");
    assert.equal(r.headers["content-length"], bytes.length);
    assert.ok(r.bytes.equals(bytes), `${path} 字节原样`);
    assert.ok(!("access-control-allow-origin" in r.headers));
  }
});

test("产物接口：SVG、伪装成 png 的文本、超过上限的图片、非图片都拒绝（固定 404，不回显）", async () => {
  for (const path of ["assets/icon.svg", "assets/fake.png", "assets/huge.png", "src/a.js", "docs/notes.md"]) {
    const r = await W.get(artifactUrl("run_image", W.deliveryOne, W.filesOne.indexOf(path)));
    assert.equal(r.status, 404, path);
    assert.deepEqual(jsonOf(r), { error: "not_found" });
    assertSafeHeaders(r);
  }
});

test("产物接口：提交号不符、序号越界、不存在的运行都拒绝；候选提交换了以后旧提交号与旧序号失效", async () => {
  const idx = W.filesOne.indexOf("assets/logo.png");
  assert.equal((await W.get(artifactUrl("run_image", W.deliveryTwo, idx))).status, 404, "不是当前交付提交");
  assert.equal((await W.get(artifactUrl("run_image", "a".repeat(40), idx))).status, 404);
  assert.equal((await W.get(artifactUrl("run_image", W.deliveryOne, W.filesOne.length))).status, 404, "序号刚好越界");
  assert.equal((await W.get(artifactUrl("run_image", W.deliveryOne, 999_999))).status, 404);
  assert.equal((await W.get(artifactUrl("run_nobody", W.deliveryOne, idx))).status, 404, "不存在的运行");
  assert.equal((await W.get(artifactUrl("run_wait_no_delivery", W.deliveryOne, 0))).status, 404, "没有交付的运行");
  assert.equal((await W.get(artifactUrl("run_no_repo", W.deliveryOne, idx))).status, 404, "项目仓库不明：不读");

  // 换候选：run_image_swap 先指向 delivery one（序号 0 = fake.png 一类），再整份改写成 delivery two。
  const swapIdx = W.filesOne.indexOf("assets/logo.png");
  assert.equal((await W.get(artifactUrl("run_image_swap", W.deliveryOne, swapIdx))).status, 200, "换之前正常");
  const b = builder("run_image_swap");
  head(b, W.ctx, { deliveryRequested: true, prompt: "# 出图（换候选）", taskType: "image" });
  working(b, T0 + 3000);
  terminal(b, T0 + 5000);
  b.clock(T0 + 6000).add("run.delivery_created", { delivery: deliveryRef("run_image_swap", W, { deliveryCommit: W.deliveryTwo, changedFiles: W.filesTwo, verification: { status: "pending", commands: [], verifiedCommit: W.deliveryTwo, results: [] } }) });
  W.store.write("run_image_swap", b.events);
  const otherIdx = W.filesTwo.indexOf("assets/other.png");
  assert.equal((await W.get(artifactUrl("run_image_swap", W.deliveryOne, swapIdx))).status, 404, "旧提交号失效：同一个序号不会指到另一份文件");
  assert.equal((await W.get(artifactUrl("run_image_swap", W.deliveryOne, otherIdx))).status, 404);
  const fresh = await W.get(artifactUrl("run_image_swap", W.deliveryTwo, otherIdx));
  assert.equal(fresh.status, 200, "新提交 + 新清单里的序号取得到");
  assert.ok(fresh.bytes.equals(PNG_1X1));
  assert.equal((await W.get(artifactUrl("run_image_swap", W.deliveryTwo, W.filesTwo.indexOf("docs/keep.md")))).status, 404, "不是图片");
});

// ===== 7. 对象已不可用 / 没有交付物 / 任务书缺失 =====

test("对象已不可用：项目仓库不明、提交不在仓库、交付事实矛盾——转录里的事实照给，读不到的只有增删行", async () => {
  const noRepo = await W.worker("run_no_repo");
  assert.equal(noRepo.identity.project, null);
  assert.equal(noRepo.deliverable.state, "unavailable");
  assert.equal(noRepo.deliverable.reason, "repository_unknown");
  assert.equal(noRepo.deliverable.commit.hash, W.deliveryOne);
  assert.ok(noRepo.deliverable.files.items.every((f) => f.added === null && f.deleted === null && f.binary === false), "增删行读不到如实 null");
  assert.equal(noRepo.deliverable.verification.status, "passed", "转录里的验证事实照给");

  const gone = await W.worker("run_git_gone");
  assert.equal(gone.deliverable.state, "unavailable");
  assert.equal(gone.deliverable.reason, "git_read_failed");
  assert.equal(gone.deliverable.commit.hash, "9".repeat(40));

  const conflict = await W.worker("run_conflict");
  assert.deepEqual(conflict.deliverable, {
    kind: "code", state: "unavailable", reason: "delivery_facts_conflict", commit: null, files: null, verification: null, reviews: [],
  });
});

test("没有交付物：写 none（不按助手的自述补）；任务书缺失如实 missing；非交付非调研的运行 kind none", async () => {
  const d = await W.worker("run_wait_no_delivery");
  assert.deepEqual(d.deliverable, { kind: "code", state: "none", reason: null, commit: null, files: null, verification: null, reviews: [] });
  assert.deepEqual(d.brief, { state: "missing", text: null, truncated: false, keptChars: 0, totalChars: 0 });
  const untyped = await W.worker("run_untyped");
  assert.deepEqual(untyped.deliverable, { kind: "none", state: "none" });
});

test("任务书：取最后一条绑定的 prompt.sent（TD-54 写两条时取后一条）；只有固定合同、没有正文也算缺失", async () => {
  const b = builder("run_two_prompts");
  head(b, W.ctx, { prompt: "# 第一条\n旧" });
  b.clock(T0 + 2500).add("prompt.sent", { prompt: "# 第二条\n新", messageId: "m1" });
  working(b, T0 + 3000);
  terminal(b, T0 + 5000);
  const detail = async (events) => projectWorkerDetail({
    run: { runId: events[0].runId, availability: "ok", state: "completed", terminal: true, taskType: "untyped", deliveryRequested: false, liveness: "terminal", stage: "terminal", project: null, failure: null, delivery: null },
    snapshot: { consults: [], runs: [] }, runsById: new Map(), events, now: NOW,
  });
  assert.equal((await detail(b.events)).brief.text, "# 第二条\n新");
  const onlyWrapper = builder("run_only_wrapper");
  head(onlyWrapper, W.ctx, { prompt: `${CONSULT_SEAT_CONTRACT_MARKER}只有合同` });
  assert.equal((await detail(onlyWrapper.events)).brief.state, "missing");
});

// ===== 8. 隔离违规的新字段 =====

test("隔离违规·物理越界：失败诊断带 reason、destination、reportedPath、resolvedPath、escapedAt", async () => {
  const d = await W.worker("run_iso_physical");
  assert.equal(d.run.state, "failed");
  assert.equal(d.health.failure.category, "workdir_escape");
  assert.deepEqual(d.health.failure.isolation, {
    reason: "file_written_physical_outside", destination: "main_checkout",
    reportedPath: "..\\escape\\a.txt", resolvedPath: "D:\\outside\\main\\a.txt", escapedAt: "D:\\outside\\link",
  });
  assert.ok(d.health.failure.evidence.length >= 1 && d.health.failure.evidence.every((e) => typeof e.fact === "string"));
  assert.deepEqual(d.delivery.isolationFailure, { code: "workdir_escape", reason: "file_written_physical_outside" });
});

test("隔离违规·词法越界：没有 escapedAt（事件里就算有也不给）", async () => {
  const d = await W.worker("run_iso_lexical");
  assert.equal(d.health.failure.isolation.reason, "file_written_lexical_outside");
  assert.equal(d.health.failure.isolation.destination, "temp");
  assert.equal(d.health.failure.isolation.escapedAt, null);
  assert.ok(!JSON.stringify(d).includes("must\\\\not\\\\show"), "词法越界的 escapedAt 不出接口");
});

test("隔离违规·畸形值不回显：非闭集 reason / destination → null；非字符串 → null；控制字符再清、超长再限、秘密脱敏", async () => {
  const response = await W.get("/api/worker?runId=run_iso_malformed");
  assertSafeBody(response);
  const { isolation } = jsonOf(response).health.failure;
  assert.equal(isolation.reason, null);
  assert.equal(isolation.destination, null);
  assert.equal(isolation.reportedPath, null, "数字不是字符串");
  assert.equal(isolation.escapedAt, null);
  assert.ok(!response.body.includes("hacked-reason") && !response.body.includes("etc/passwd"), "畸形的闭集值不回显");
  assert.ok(!/[\u0000-\u0008\u000b-\u001f]/.test(isolation.resolvedPath), "控制字符已清");
  assert.ok(isolation.resolvedPath.length <= 300, "再限一次长");
  assert.ok(isolation.resolvedPath.includes("[REDACTED"));
});

test("projectIsolationViolationFields / projectWorkdirEscapeFields：闭集成员、escapedAt 只在 *_physical_outside、别的运行的事件不算", () => {
  assert.deepEqual(projectIsolationViolationFields(null), { reason: null, destination: null, reportedPath: null, resolvedPath: null, escapedAt: null });
  assert.equal(projectIsolationViolationFields({ reason: "write_intent_physical_outside", escapedAt: "E:\\x" }).escapedAt, "E:\\x");
  assert.equal(projectIsolationViolationFields({ reason: "write_intent_physical_unresolved", escapedAt: "E:\\x" }).escapedAt, null);
  assert.equal(projectIsolationViolationFields({ escapedAt: "E:\\x" }).escapedAt, null, "没有 reason 就不给 escapedAt");
  const events = [
    { type: "run.isolation_violation", runId: "run_other", code: "workdir_escape", reason: "file_written_lexical_outside" },
    { type: "run.isolation_violation", runId: "run_mine", code: "something_else", reason: "file_written_lexical_outside" },
  ];
  assert.equal(projectWorkdirEscapeFields(events, "run_mine"), null, "别的运行 / 非安全码的事件不算");
  assert.equal(projectWorkdirEscapeFields([...events, { type: "run.isolation_violation", runId: "run_mine", code: "workdir_escape", reason: "file_written_lexical_outside", destination: "home" }], "run_mine").destination, "home");
  assert.equal(projectWorkdirEscapeFields("nope", "run_mine"), null);
});

// ===== 9. 守卫：鉴权、参数闭集、404、方法、泄漏 =====

test("鉴权：两个接口无令牌 / 错令牌 401，固定错误体，先于参数与 loading", async () => {
  for (const url of ["/api/worker?runId=run_code_pass", artifactUrl("run_image", W.deliveryOne, 0), "/api/worker", "/api/artifact?x=1"]) {
    const bare = await W.get(url, {});
    assert.equal(bare.status, 401, url);
    assert.deepEqual(jsonOf(bare), { error: "unauthorized" });
    assertSafeHeaders(bare);
    for (const authorization of [`Bearer ${"0".repeat(64)}`, W.server.token, `bearer ${W.server.token}`, "Bearer"]) {
      assert.equal((await W.get(url, { authorization })).status, 401, `${url} 错令牌`);
    }
  }
});

test("方法：两个接口只许 GET——其余 405 + Allow: GET，不开 CORS", async () => {
  for (const url of ["/api/worker?runId=run_code_pass", artifactUrl("run_image", W.deliveryOne, 0)]) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      const r = await drive(W.server.handler, { method, url, headers: W.auth });
      assert.equal(r.status, 405, `${method} ${url}`);
      assert.equal(r.headers.allow, "GET");
      assert.deepEqual(jsonOf(r), { error: "method_not_allowed" });
      assert.ok(!("access-control-allow-origin" in r.headers));
    }
  }
});

test("参数闭集：/api/worker 只认 runId——多余键、重复键、缺失、形状不对都 400，固定错误体", async () => {
  for (const url of [
    "/api/worker", "/api/worker?runId=", "/api/worker?runId=run_code_pass&x=1", "/api/worker?runId=run_code_pass&runId=run_code_pass",
    "/api/worker?runId=bad/path", "/api/worker?runId=-dash", "/api/worker?runId=../x", "/api/worker?runId=.hidden", "/api/worker?runId=a%00b",
    "/api/worker?runId=run_code_pass&runDir=/evil", "/api/worker?runId=run_code_pass&path=x", "/api/worker?project=alpha-11111111",
  ]) {
    const r = await W.get(url);
    assert.equal(r.status, 400, `${url} → 400`);
    assert.deepEqual(jsonOf(r), { error: "bad_request" });
    assertSafeHeaders(r);
  }
});

test("参数闭集：/api/artifact 只认 runId + commit + fileIndex——缺任一、多余、重复、形状不对都 400；不接受路径参数", async () => {
  const ok = `runId=run_image&commit=${W.deliveryOne}&fileIndex=0`;
  for (const url of [
    "/api/artifact", `/api/artifact?commit=${W.deliveryOne}&fileIndex=0`, `/api/artifact?runId=run_image&fileIndex=0`, `/api/artifact?runId=run_image&commit=${W.deliveryOne}`,
    `/api/artifact?${ok}&x=1`, `/api/artifact?${ok}&fileIndex=1`, `/api/artifact?${ok}&commit=${W.deliveryOne}`, `/api/artifact?${ok}&runId=run_image`,
    `/api/artifact?${ok}&path=assets/logo.png`, `/api/artifact?${ok}&file=../../etc/passwd`,
    `/api/artifact?runId=bad/path&commit=${W.deliveryOne}&fileIndex=0`,
    `/api/artifact?runId=run_image&commit=${W.deliveryOne.slice(0, 39)}&fileIndex=0`,
    `/api/artifact?runId=run_image&commit=${W.deliveryOne.toUpperCase()}&fileIndex=0`,
    `/api/artifact?runId=run_image&commit=${"g".repeat(40)}&fileIndex=0`,
    `/api/artifact?runId=run_image&commit=HEAD&fileIndex=0`,
    ...["-1", "1.5", "01", "abc", "", "99999999", "1e2", "0x1", "+1", " 1"].map((i) => `/api/artifact?runId=run_image&commit=${W.deliveryOne}&fileIndex=${encodeURIComponent(i)}`),
  ]) {
    const r = await W.get(url);
    assert.equal(r.status, 400, `${url} → 400`);
    assert.deepEqual(jsonOf(r), { error: "bad_request" });
  }
});

test("不存在或不可用 → 固定 404，不回显 runId 以外的任何东西：未知运行、坏转录、多份内容冲突", async () => {
  for (const runId of ["run_nobody", "run_corrupt", "run_dup"]) {
    const r = await W.get(`/api/worker?runId=${runId}`);
    assert.equal(r.status, 404, runId);
    assert.deepEqual(jsonOf(r), { error: "not_found" });
    assertSafeHeaders(r);
    assert.ok(!r.body.includes(runId), "404 体里没有 runId");
  }
});

test("首次发布之前：/api/worker 200 + status loading（不带数据）；/api/artifact 固定 404", async () => {
  assert.equal(W.preRefresh.status, 200);
  assert.deepEqual(jsonOf(W.preRefresh), { status: "loading" });
  const s = createOwnerDashboardServer({ runDir: W.store.runDir, workspaceRoot: W.base, env: SERVER_ENV, nowFn: () => NOW });
  const r = await drive(s.handler, { url: artifactUrl("run_image", W.deliveryOne, 0), headers: { authorization: `Bearer ${s.token}` } });
  assert.equal(r.status, 404);
  await s.close();
});

test("响应不含仓库路径、工作树路径、运行目录与未脱敏的秘密——逐个运行扫一遍", async () => {
  for (const runId of [
    "run_code_pass", "run_code_fail", "run_code_unavail", "run_code_pending", "run_round_1", "run_round_2", "run_image", "run_no_repo", "run_git_gone",
    "run_conflict", "run_research", "run_research_long", "run_research_none", "run_seat_a", "run_seat_b", "run_wait_no_delivery", "run_untyped",
    "run_silent", "run_starting", "run_nostage", "run_iso_physical", "run_iso_lexical",
  ]) {
    const r = await W.get(`/api/worker?runId=${runId}`);
    assert.equal(r.status, 200, runId);
    assertSafeBody(r);
  }
});

test("读模型的两个只读入口：readRunEvents 的授权同 resolveRun（读不出 / 冲突 / 不在本目录都是 null）；projectRepoRoot 只给服务端、不进快照", async () => {
  const model = createOwnerReadModel({ runDir: W.store.runDir });
  assert.equal(await model.readRunEvents("run_code_pass"), null, "首次 refresh 完成前一律 null");
  assert.equal(model.projectRepoRoot(W.store.alpha.slug), null);
  await model.refresh();
  const events = await model.readRunEvents("run_code_pass");
  assert.ok(Array.isArray(events) && events.length > 0 && events.every((e) => e.runId === "run_code_pass"));
  for (const runId of ["run_nobody", "run_corrupt", "run_dup", "bad/id", "", null, 42]) {
    assert.equal(await model.readRunEvents(runId), null, String(runId));
  }
  assert.equal(model.projectRepoRoot(W.store.alpha.slug), W.repo, "项目记录绑定的仓库根");
  for (const slug of ["nope", "", undefined, null, 7]) assert.equal(model.projectRepoRoot(slug), null, String(slug));
  assert.ok(!JSON.stringify(model.snapshot({ now: NOW })).includes(JSON.stringify(W.repo).slice(1, -1)), "快照里没有仓库路径");
});

test("内部失败 → 固定 500，错误原文（含路径）不出接口；读模型没有这两个读入口 → 固定 404", async () => {
  const boom = `EACCES: permission denied, open '${W.repo}\\secret.jsonl' ${EXACT_SECRET}`;
  const throwing = createOwnerDashboardServer({
    runDir: W.store.runDir, workspaceRoot: W.base, env: SERVER_ENV, nowFn: () => NOW,
    createReadModelFn: (input) => ({ ...createOwnerReadModel(input), readRunEvents: async () => { throw new Error(boom); } }),
  });
  assert.equal(await throwing.refreshNow(), "ready");
  const auth = { authorization: `Bearer ${throwing.token}` };
  for (const url of ["/api/worker?runId=run_code_pass", artifactUrl("run_image", W.deliveryOne, 0)]) {
    const r = await drive(throwing.handler, { url, headers: auth });
    assert.equal(r.status, 500, url);
    assert.deepEqual(jsonOf(r), { error: "internal" });
    assert.ok(!r.body.includes("EACCES") && !r.body.includes(W.repo) && !r.body.includes(EXACT_SECRET));
  }
  await throwing.close();

  const bare = createOwnerDashboardServer({
    runDir: W.store.runDir, workspaceRoot: W.base, nowFn: () => NOW,
    createReadModelFn: (input) => {
      const { refresh, snapshot } = createOwnerReadModel(input);
      return { refresh, snapshot };
    },
  });
  assert.equal(await bare.refreshNow(), "ready");
  const r = await drive(bare.handler, { url: "/api/worker?runId=run_code_pass", headers: { authorization: `Bearer ${bare.token}` } });
  assert.equal(r.status, 404);
  assert.deepEqual(jsonOf(r), { error: "not_found" });
  await bare.close();
});

test("闭集：交付物的 kind / state / reason 都落在导出的闭集里（逐个运行扫一遍）", async () => {
  for (const runId of [
    "run_code_pass", "run_code_pending", "run_image", "run_no_repo", "run_git_gone", "run_conflict", "run_research", "run_research_none",
    "run_seat_a", "run_wait_no_delivery", "run_untyped",
  ]) {
    const { deliverable } = await W.worker(runId);
    assert.ok(OWNER_DELIVERABLE_KINDS.includes(deliverable.kind), `${runId}: kind ${deliverable.kind}`);
    assert.ok(OWNER_DELIVERABLE_STATES.includes(deliverable.state), `${runId}: state ${deliverable.state}`);
    if (deliverable.state === "unavailable") assert.ok(OWNER_DELIVERABLE_UNAVAILABLE_REASONS.includes(deliverable.reason), runId);
    else assert.ok(deliverable.reason === null || deliverable.reason === undefined, `${runId}: 只有 unavailable 才有 reason`);
  }
});

test("路由是闭集：服务源码里的 /api/ 路由恰好是这 7 个；其余 /api/* 固定 404", async () => {
  const src = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "../..", "src", "ownerDashboardServer.js"), "utf8");
  const declared = new Set([...src.matchAll(/"\/api\/([a-z]+)"/g)].map((m) => m[1]));
  assert.deepEqual([...declared].sort(), ["activity", "artifact", "attention", "overview", "runs", "worker", "workers"]);
  for (const url of ["/api/worker/extra", "/api/artifacts", "/api/Worker", "/api/"]) {
    assert.equal((await W.get(url)).status, 404, url);
  }
});

// ===== 10. 文件清单的路径与上限 =====

test("文件清单：不合规的路径（绝对、..、空段、控制字符、非字符串）给 [path_withheld]；超过上限只列前 N 项并写明 total", async () => {
  const bad = ["/etc/passwd", "C:\\Windows\\x", "../escape", "a//b", "ok/file.txt", "bad\nname", 42, null, `tok/${SHAPE_SECRET}.txt`];
  const many = Array.from({ length: OWNER_FILES_MAX + 7 }, (_, i) => `gen/f${String(i).padStart(4, "0")}.txt`);
  const events = [
    ...deliveredRun("run_paths", W, W.ctx, { createdOver: { changedFiles: bad }, outcomeOver: { changedFiles: bad } }).events,
  ];
  const detail = await projectWorkerDetail({
    run: { runId: "run_paths", availability: "ok", state: "completed", terminal: true, taskType: "code", deliveryRequested: true, liveness: "terminal", stage: "terminal", project: null, failure: null, delivery: null },
    snapshot: { consults: [], runs: [] }, runsById: new Map(), events, now: NOW,
    repoRoot: W.repo,
    readNumstat: async () => new Map(),
  });
  const paths = detail.deliverable.files.items.map((f) => f.path);
  assert.deepEqual(paths.slice(0, 4), Array(4).fill(OWNER_PATH_WITHHELD));
  assert.equal(paths[4], "ok/file.txt");
  assert.deepEqual(paths.slice(5, 8), Array(3).fill(OWNER_PATH_WITHHELD), "控制字符、数字、null");
  assert.ok(paths[8].includes("[REDACTED"), "路径里的秘密形状脱敏");

  const big = deliveredRun("run_many_files", W, W.ctx, { createdOver: { changedFiles: many }, outcomeOver: { changedFiles: many } }).events;
  const d = await projectWorkerDetail({
    run: { runId: "run_many_files", availability: "ok", state: "completed", terminal: true, taskType: "code", deliveryRequested: true, liveness: "terminal", stage: "terminal", project: null, failure: null, delivery: null },
    snapshot: { consults: [], runs: [] }, runsById: new Map(), events: big, now: NOW, repoRoot: W.repo, readNumstat: async () => new Map(),
  });
  assert.equal(d.deliverable.files.total, OWNER_FILES_MAX + 7);
  assert.equal(d.deliverable.files.truncated, true);
  assert.equal(d.deliverable.files.items.length, OWNER_FILES_MAX);
});

// ===== 11. currentDelivery（详情与产物接口共用的"当前交付"） =====

test("currentDelivery：none / bound / conflict 三态；验证没收口也认 created 的提交；换了候选就是新的提交", () => {
  const empty = builder("run_cd");
  head(empty, W.ctx, { deliveryRequested: true });
  assert.equal(currentDelivery(empty.events, "run_cd").state, "none");
  const pending = builder("run_cd");
  head(pending, W.ctx, { deliveryRequested: true });
  created(pending, T0 + 6000, W);
  const bound = currentDelivery(pending.events, "run_cd");
  assert.equal(bound.state, "bound");
  assert.equal(bound.commit, W.deliveryOne);
  assert.equal(bound.baseCommit, W.baseCommit);
  assert.deepEqual(bound.changedFiles, W.filesOne);
  created(pending, T0 + 6500, W);
  assert.equal(currentDelivery(pending.events, "run_cd").state, "conflict");
  assert.equal(currentDelivery("not events", "run_cd").state, "conflict", "校验抛错按矛盾处理，不抛");
});

// ===== 12. ownerArtifact：Git 对象读取 =====

test("sniffImageContentType：只认 png / jpeg / webp 的文件头魔数；SVG、文本、截断的头都不认", () => {
  assert.equal(sniffImageContentType(PNG_1X1), "image/png");
  assert.equal(sniffImageContentType(JPEG_BYTES), "image/jpeg");
  assert.equal(sniffImageContentType(WEBP_BYTES), "image/webp");
  assert.equal(sniffImageContentType(Buffer.from(SVG_TEXT)), null);
  assert.equal(sniffImageContentType(Buffer.from(FAKE_PNG_TEXT)), null);
  assert.equal(sniffImageContentType(Buffer.from("GIF89a....")), null);
  assert.equal(sniffImageContentType(PNG_1X1.subarray(0, 7)), null, "魔数不全");
  assert.equal(sniffImageContentType(Buffer.from("RIFF\0\0\0\0WAVE....")), null, "RIFF 但不是 WEBP");
  assert.equal(sniffImageContentType(Buffer.alloc(0)), null);
  assert.equal(sniffImageContentType("not bytes"), null);
});

test("readCommitImage：真实仓库里取得到图片；不存在的对象 / 形状不对的提交号或路径 / 超限 / 非图片各给闭集原因", async () => {
  const ok = await readCommitImage({ repoRoot: W.repo, commit: W.deliveryOne, path: "assets/logo.png" });
  assert.equal(ok.ok, true);
  assert.equal(ok.contentType, "image/png");
  assert.ok(ok.bytes.equals(PNG_1X1));
  assert.deepEqual(await readCommitImage({ repoRoot: W.repo, commit: W.deliveryOne, path: "assets/fake.png" }), { ok: false, reason: "not_image" });
  assert.deepEqual(await readCommitImage({ repoRoot: W.repo, commit: W.deliveryOne, path: "assets/huge.png" }), { ok: false, reason: "too_large" });
  assert.deepEqual(await readCommitImage({ repoRoot: W.repo, commit: W.deliveryOne, path: "assets/logo.png", maxBytes: PNG_1X1.length - 1 }), { ok: false, reason: "too_large" }, "上限是可配置的具名常量");
  assert.equal((await readCommitImage({ repoRoot: W.repo, commit: W.deliveryOne, path: "assets/logo.png", maxBytes: PNG_1X1.length })).ok, true, "恰好等于上限放行");
  for (const bad of [
    { commit: "9".repeat(40), path: "assets/logo.png" }, // 对象不存在
    { commit: W.deliveryOne, path: "assets/missing.png" }, // 路径不在提交里
    { commit: "HEAD", path: "assets/logo.png" }, // 不是规范提交号
    { commit: W.deliveryOne, path: "../assets/logo.png" }, // 路径形状不对
    { commit: W.deliveryOne, path: "/assets/logo.png" },
    { commit: W.deliveryOne, path: "" },
  ]) {
    assert.deepEqual(await readCommitImage({ repoRoot: W.repo, ...bad }), { ok: false, reason: "unreadable" }, JSON.stringify(bad));
  }
  assert.deepEqual(await readCommitImage({ repoRoot: join(W.base, "not-a-repo"), commit: W.deliveryOne, path: "assets/logo.png" }), { ok: false, reason: "unreadable" });
});

test("readCommitImage / readDeliveryNumstat：git 超时、非零退出、输出超限都落成失败；传给 git 的是只读结构化参数", async () => {
  const calls = [];
  const failing = async (args, repoRoot, opts) => { calls.push({ args, repoRoot, opts }); throw Object.assign(new Error("timed out"), { killed: true }); };
  assert.deepEqual(await readCommitImage({ repoRoot: W.repo, commit: W.deliveryOne, path: "assets/logo.png", runGitFn: failing }), { ok: false, reason: "unreadable" });
  await assert.rejects(() => readDeliveryNumstat({ repoRoot: W.repo, baseCommit: W.baseCommit, commit: W.deliveryOne, runGitFn: failing }));
  assert.deepEqual(calls[0].args, ["cat-file", "-s", `${W.deliveryOne}:assets/logo.png`]);
  assert.deepEqual(calls[1].args, ["diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", W.baseCommit, W.deliveryOne, "--"]);
  assert.ok(calls.every((c) => Number.isInteger(c.opts.timeoutMs) && c.opts.timeoutMs > 0 && c.opts.maxBuffer > 0), "每次都有超时与输出上限");
  await assert.rejects(() => readDeliveryNumstat({ repoRoot: W.repo, baseCommit: "HEAD", commit: W.deliveryOne, runGitFn: async () => Buffer.alloc(0) }), /commit shape/);
  await assert.rejects(() => readDeliveryNumstat({ repoRoot: W.repo, baseCommit: W.baseCommit, commit: W.deliveryOne, runGitFn: async () => Buffer.from("garbage") }), /record shape/);
  // 量到的大小是假的、读出的字节与上限对不上：只信上限（缓冲上限由 runGit 兜底）。
  assert.deepEqual(await readCommitImage({
    repoRoot: W.repo, commit: W.deliveryOne, path: "assets/logo.png",
    runGitFn: async (args) => (args[1] === "-s" ? Buffer.from("not a number") : PNG_1X1),
  }), { ok: false, reason: "unreadable" });
});

test("readDeliveryNumstat：真实仓库的逐文件增删行；createNumstatReader 同一份交付只读一次，失败不缓存，缓存有上限", async () => {
  const stats = await readDeliveryNumstat({ repoRoot: W.repo, baseCommit: W.baseCommit, commit: W.deliveryOne });
  assert.deepEqual(stats.get("src/a.js"), { added: 3, deleted: 1, binary: false });
  assert.deepEqual(stats.get("assets/logo.png"), { added: null, deleted: null, binary: true });
  assert.equal(stats.size, W.filesOne.length);

  let runs = 0;
  const counting = async (...args) => { runs += 1; return runGitReadOnly(...args); };
  const read = createNumstatReader({ runGitFn: counting });
  const input = { repoRoot: W.repo, baseCommit: W.baseCommit, commit: W.deliveryOne };
  await read(input);
  await read(input);
  assert.equal(runs, 1, "提交对象不可变：同一份交付只读一次");
  let fail = true;
  const flaky = createNumstatReader({ runGitFn: async (...args) => { if (fail) throw new Error("boom"); return runGitReadOnly(...args); } });
  await assert.rejects(() => flaky(input));
  fail = false;
  assert.equal((await flaky(input)).size, W.filesOne.length, "失败没有被缓存，下次重试");

  runs = 0;
  const tiny = createNumstatReader({ runGitFn: counting, maxEntries: 1 });
  await tiny(input);
  await tiny({ ...input, commit: W.deliveryTwo });
  await tiny(input);
  assert.equal(runs, 3, "缓存满了丢最早的");
});

// ===== 13. 共用的文本管道 =====

test("headOfRedactedText：先 exact 脱敏、再形状脱敏、再清控制字符（LF/TAB 保留）、最后取头限长并给出总长", () => {
  const redactor = createSecretRedactor({ OWNER_TEST_API_KEY: EXACT_SECRET });
  const out = headOfRedactedText(`a\tb\nc\u0007d ${EXACT_SECRET} ${SHAPE_SECRET}`, redactor, 1000);
  assert.equal(out.truncated, false);
  assert.ok(out.text.startsWith("a\tb\nc\uFFFDd "), "LF/TAB 保留，其余控制字符被替换");
  assert.ok(!out.text.includes(EXACT_SECRET) && !out.text.includes(SHAPE_SECRET));
  const cut = headOfRedactedText("x".repeat(50), redactor, 10);
  assert.deepEqual([cut.text.length, cut.truncated, cut.totalChars], [10, true, 50]);
  const pair = headOfRedactedText(`${"x".repeat(9)}😀tail`, redactor, 10);
  assert.ok(!/[\uD800-\uDBFF]$/.test(pair.text), "不切开代理对");
  assert.deepEqual(headOfRedactedText("", redactor, 10), { text: "", truncated: false, totalChars: 0 });
  assert.deepEqual(headOfRedactedText(42, redactor, 10), { text: "", truncated: false, totalChars: 0 });
});
