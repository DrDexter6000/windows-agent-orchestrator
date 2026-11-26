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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { rmrfRetry } from "../_rmrfHelper.mjs";
import { createOwnerDashboardServer } from "../../src/ownerDashboardServer.js";
import {
  CONSULT_SEAT_CONTRACT_MARKER,
  CONSULT_SEAT_CONTRACT_TEXT,
  buildConsultSeatPrompt,
} from "../../src/application/consultService.js";
import { OWNER_TITLE_MAX_CHARS, createOwnerReadModel } from "../../src/application/ownerReadModel.js";
import {
  OWNER_ANSWER_MAX_CHARS,
  OWNER_CONSULT_SEATS_MAX,
  OWNER_DELIVERABLE_KINDS,
  OWNER_DELIVERABLE_STATES,
  OWNER_DELIVERABLE_UNAVAILABLE_REASONS,
  OWNER_FILES_MAX,
  OWNER_PATH_WITHHELD,
  OWNER_RUN_ID_MAX_CHARS,
  currentDelivery,
  projectWorkerDetail,
} from "../../src/application/ownerWorkerDetail.js";
import {
  OWNER_ARTIFACT_MAX_BYTES,
  createDeliveryProver,
  createNumstatReader,
  readCommitImage,
  readDeliveryNumstat,
  runGitReadOnly,
  sniffImageContentType,
} from "../../src/application/ownerArtifact.js";
import { projectIsolationViolation, isolationViolationDetail } from "../../src/diagnosis.js";
import { headOfRedactedText } from "../../src/application/runActivityProjection.js";
import { createSecretRedactor } from "../../src/secretRedaction.js";
import { DELIVERY_IDENTITY, deliveryCommitMessage } from "../../src/delivery.js";

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
/** 会审记录里声明的结论字段（写入端追加的合同后缀按它生成）。 */
const DECLARED_Q1 = { Q1: ["PASS", "PASS_WITH_NOTES", "FIX_FIRST"] };
/** 隔离违规路径里秘密的起点：`D:\outside\`（11）+ 填充 + 空格 = 295，上限 300 正好切在秘密中间。 */
const ISOLATION_PAD = 283;
/** 仓库与运行目录之外的路径（正文、答复、诊断、命令里会出现）。 */
const OUTSIDE_WIN = "D:\\outside\\docs\\spec.md";
const OUTSIDE_POSIX = "/opt/outside/tools/run.sh";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
// 真实可解码的小图（第 141 批会审：此前 JPEG / WebP 的正例只是带签名的字节）：1×1 基线 JFIF
// JPEG（GDI+ 生成，Windows 图像库能解码）；1×1 有损与无损 WebP（Windows WIC 能解码）。
const JPEG_BYTES = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDwKiiivzI/uM//2Q==",
  "base64",
);
const WEBP_BYTES = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");
const WEBP_LOSSLESS_BYTES = Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64");
const HUGE_PNG = Buffer.concat([PNG_1X1.subarray(0, 8), Buffer.alloc(OWNER_ARTIFACT_MAX_BYTES + 1 - 8)]);
const FAKE_PNG_TEXT = "this is not really a png\n";
const SVG_TEXT = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>\n';

const git = (cwd, ...args) => execFileSync("git", args, {
  cwd,
  encoding: "utf8",
  env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" },
}).trim();

/** 以 WAO 固定打包身份（delivery.js 的 DELIVERY_IDENTITY）跑 git，用来造真实形状的交付提交。 */
// 测试里按运行取交付提交（world 的 deliveryOne / deliveryTwo 是两份树的"源提交"，不是任何运行的交付提交）。
const commitOne = (runId) => W.commitFor(runId, W.deliveryOne);
const commitTwo = (runId) => W.commitFor(runId, W.deliveryTwo);
const WAO_IDENTITY_ENV = {
  GIT_AUTHOR_NAME: DELIVERY_IDENTITY.name, GIT_AUTHOR_EMAIL: DELIVERY_IDENTITY.email,
  GIT_COMMITTER_NAME: DELIVERY_IDENTITY.name, GIT_COMMITTER_EMAIL: DELIVERY_IDENTITY.email,
};
const gitAs = (cwd, env, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...env } }).trim();

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
  // assets/base.png：基线里已有、交付里没改的图片（"清单里列了没变更的图片"的反例用）。
  putFiles(repo, { "src/a.js": "l1\nl2\nl3\nl4\n", "docs/keep.md": "keep\n", "assets/base.png": PNG_1X1 });
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
    "assets/pic-lossless.webp": WEBP_LOSSLESS_BYTES,
    "assets/huge.png": HUGE_PNG,
    // 只有前缀对的伪图（第 141 批会审）：签名后接 SVG；RIFF + 零长度 + WEBP + SVG；截断；RIFF 声明长度对不上。
    "assets/forged-sig.png": Buffer.concat([PNG_1X1.subarray(0, 8), Buffer.from(SVG_TEXT)]),
    "assets/forged-riff.webp": Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.from(SVG_TEXT)]),
    "assets/trunc.png": PNG_1X1.subarray(0, 20),
    "assets/trunc.jpg": JPEG_BYTES.subarray(0, 3),
    "assets/badlen.webp": Buffer.concat([WEBP_BYTES.subarray(0, 4), Buffer.from([0x40, 0, 0, 0]), WEBP_BYTES.subarray(8)]),
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
  // 真实交付提交的形状：同一份树、父提交 = 基线、作者与提交者是 WAO 固定打包身份、提交说明恰好是
  // `wao-delivery: <runId>`。证明器按运行逐个核对，所以每个运行要有自己的提交（树取自 source）。
  const commits = new Map();
  const commitFor = (runId, source) => {
    const key = `${runId}\u0000${source}`;
    if (!commits.has(key)) {
      commits.set(key, gitAs(repo, WAO_IDENTITY_ENV, "commit-tree", `${source}^{tree}`, "-p", baseCommit, "-m", deliveryCommitMessage(runId)));
    }
    return commits.get(key);
  };
  return { repo, baseCommit, deliveryOne, filesOne, deliveryTwo, filesTwo, commitFor };
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

/** 这个运行的交付提交（world.deliveryOne 那份树）。 */
const commitOf = (runId, world) => world.commitFor(runId, world.deliveryOne);

/** 交付引用（形状取自 ownerReadModelFacts.test.js）。 */
function deliveryRef(runId, world, over = {}) {
  const commit = commitOf(runId, world);
  return {
    schemaVersion: 1,
    kind: "git_commit",
    runId,
    baseCommit: world.baseCommit,
    deliveryCommit: commit,
    branch: `wao/${runId}`,
    worktreePath: `${world.repo}\\.wao-worktrees\\${runId}`,
    changedFiles: world.filesOne,
    verification: { status: "pending", commands: ["npm test"], verifiedCommit: commit, results: [] },
    acceptance: { status: "pending", reviewerType: "lead_agent" },
    integration: { status: "pending", targetCommit: null },
    ...over,
  };
}

function verifiedRef(runId, world, status, over = {}) {
  const commit = commitOf(runId, world);
  const passedResult = { index: 0, command: "npm test", exitCode: 0, timedOut: false, durationMs: 4321, stdoutBytes: 12, stderrBytes: 0, stdoutTail: "", stderrTail: "" };
  const failedResult = { ...passedResult, exitCode: 1, durationMs: 777, stderrBytes: 30, stderrTail: `token ${SHAPE_SECRET}` };
  const verification = {
    passed: { status, commands: ["npm test"], results: [passedResult], verifiedCommit: commit },
    failed: {
      status, commands: ["npm test"], results: [failedResult], verifiedCommit: commit,
      failureCode: "command_failed", failedPhase: "assertion", failedCommandIndex: 0,
    },
    unavailable: { status, unavailableReason: "no runnable verification", commands: [], results: [], verifiedCommit: commit },
  }[status];
  return deliveryRef(runId, world, { verification, ...over });
}

const created = (b, at, world, over) => b.clock(at).add("run.delivery_created", { delivery: deliveryRef(b.runId, world, over) });
const outcome = (b, at, world, status, over) => b.clock(at).add(`run.delivery_verification_${status}`, {
  delivery: verifiedRef(b.runId, world, status, over),
});
const decide = (b, at, world, kind) => b.clock(at).add(`run.delivery_${kind}`, {
  delivery: verifiedRef(b.runId, world, "passed", { acceptance: { status: kind, reviewerType: "lead_agent" } }),
  deliveryCommit: commitOf(b.runId, world),
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
  // 席位 prompt 与写入端同形：任务书 + 视角片段 + 固定合同后缀（标记 + 固定句 + 声明字段段）。
  const declaredQ1 = DECLARED_Q1;
  const seatBody = "# 会审任务书\n## Q1 是否可行\n视角：看边界";
  const seatPrompt = buildConsultSeatPrompt(seatBody, declaredQ1); // 写入端（runConsult 扇出）用的同一个构造函数
  const seatSuffix = seatPrompt.slice(seatBody.length);
  world.seatSuffix = seatSuffix;
  const seatRun = (runId, agentId, reply, state = "completed", prompt = seatPrompt) => {
    const b = builder(runId, { agentId });
    head(b, ctx, { roleId: "auditor", laneId: agentId, prompt });
    working(b, T0 + 3000);
    if (reply !== null) say(b, T0 + 4000, reply);
    if (state !== "running") terminal(b, T0 + 5000, state);
    s.write(runId, b.events);
  };
  seatRun("run_seat_a", "sol", "## Q1: PASS\n\n理由。");
  seatRun("run_seat_b", "astra", "## Q1: FIX_FIRST\n\n要改。");
  const writeConsult = (consultId, over) => writeFileSync(join(consultsDir, `${consultId}.json`), JSON.stringify({
    consultId,
    createdAt: iso(NOW - 3000),
    brief: { path: `${world.repo}\\briefs\\plan.md`, sha256: "a".repeat(64) },
    budgetMs: 0,
    elapsedMs: 5,
    questions: [{ q: 1, heading: "## Q1 是否可行" }],
    declaredFields: declaredQ1,
    fieldDiff: [],
    ...over,
  }, null, 2), "utf8");
  const consultId = "consult_20261124120000001aaaaaa";
  writeConsult(consultId, {
    reviewedRunId: "run_code_pass",
    seats: [
      { agentId: "sol", runId: "run_seat_a", runState: "completed", formatState: "structured" },
      { agentId: "astra", runId: "run_seat_b", runState: "completed", formatState: "structured" },
      { agentId: "kimi", runId: "run_seat_gone", runState: "running", formatState: "structured" },
    ],
  });
  world.consultId = consultId;

  // 第二场：早于它所审交付的创建事件（afterCurrentDelivery:false）；席位里"完成但没有答复"
  // 与"失败但有答复"并存（几席已到只数"已到终态且收到答复"的）。
  s.write("run_code_stale_review", deliveredRun("run_code_stale_review", world, ctx, { title: "过期会审的被审运行" }).events);
  seatRun("run_seat_c", "sol", null, "completed");
  seatRun("run_seat_d", "astra", "## Q1: PASS\n\n理由。", "failed");
  seatRun("run_seat_e", "kimi", null, "running");
  world.staleConsultId = "consult_20261124100000500bbbbbb";
  writeConsult(world.staleConsultId, {
    createdAt: iso(T0 + 5000),
    reviewedRunId: "run_code_stale_review",
    seats: [
      { agentId: "sol", runId: "run_seat_c", runState: "completed", formatState: "empty" },
      { agentId: "astra", runId: "run_seat_d", runState: "failed", formatState: "structured" },
      { agentId: "kimi", runId: "run_seat_e", runState: "running", formatState: "empty" },
    ],
  });

  // 第三场：全员 FIX_FIRST（不同值 = 否；任一 FIX_FIRST = 是）。
  seatRun("run_seat_f", "sol", "## Q1: FIX_FIRST\n\n要改。");
  seatRun("run_seat_g", "astra", "## Q1: FIX_FIRST\n\n也要改。");
  world.allFixConsultId = "consult_20261124110000500cccccc";
  writeConsult(world.allFixConsultId, {
    reviewedRunId: "run_code_fail",
    seats: [
      { agentId: "sol", runId: "run_seat_f", runState: "completed", formatState: "structured" },
      { agentId: "astra", runId: "run_seat_g", runState: "completed", formatState: "structured" },
    ],
  });

  // 第五场：记录声明了多行候选（MCP schema 接受任意非空字符串）。席位 m 的 prompt 由写入端同一个
  // 构造函数按这份声明生成 → 剥得掉；席位 n 的 prompt 按另一份声明生成、与记录对不上 → 不剥，保留全文。
  world.multiFields = { Q1: ["PASS", "FIX_FIRST"], Q2: ["第一行\n第二行", "B"] };
  world.multiBody = "# 多行候选会审\n## Q1 结论\n## Q2 选哪个";
  seatRun("run_seat_m", "sol", "## Q1: PASS", "completed", buildConsultSeatPrompt(world.multiBody, world.multiFields));
  seatRun("run_seat_n", "astra", "## Q1: PASS", "completed", buildConsultSeatPrompt(world.multiBody, DECLARED_Q1));
  writeConsult("consult_20261124116000500eeeeee", {
    reviewedRunId: "run_hist_delivery",
    declaredFields: world.multiFields,
    seats: [
      { agentId: "sol", runId: "run_seat_m", runState: "completed", formatState: "structured" },
      { agentId: "astra", runId: "run_seat_n", runState: "completed", formatState: "structured" },
    ],
  });

  // 第四场：席位很多、且有一个超长的（合法字符）runId——席位行有上限、runId 有长度限制。
  s.write("run_code_review_big", deliveredRun("run_code_review_big", world, ctx, { title: "席位很多的被审运行" }).events);
  world.hugeSeatRunId = "r".repeat(8196);
  world.bigConsultId = "consult_20261124115000500dddddd";
  writeConsult(world.bigConsultId, {
    reviewedRunId: "run_code_review_big",
    seats: Array.from({ length: 30 }, (_, i) => ({
      agentId: `seat-${String(i).padStart(2, "0")}`,
      runId: i === 0 ? world.hugeSeatRunId : `run_big_seat_${i}`,
      runState: "running",
      formatState: "empty",
    })),
  });

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
  // 畸形值：原因合法（越界类）才有字段可放行；其余字段非字符串、闭集外、控制字符、秘密、超长。
  isolation("run_iso_malformed", {
    reason: "file_written_physical_outside", destination: "../../etc/passwd", reportedPath: 12345,
    resolvedPath: `D:\\x\u0007y\nz ${SHAPE_SECRET} ${"p".repeat(600)}`, escapedAt: { nested: true },
  });
  // 原因不在闭集：说不清是不是越界，路径一个都不给。
  isolation("run_iso_badreason", {
    reason: "hacked-reason", destination: "temp", reportedPath: "D:\\outside\\bad.txt", resolvedPath: "D:\\outside\\bad.txt",
  });
  // 先脱敏、后限长：秘密（服务端 env 里的精确值、形状）正好跨在 300 的截断点上。
  isolation("run_iso_straddle", {
    reason: "file_written_lexical_outside", destination: "other",
    reportedPath: `D:\\outside\\${"p".repeat(ISOLATION_PAD)} ${EXACT_SECRET}`,
    resolvedPath: `D:\\outside\\${"q".repeat(ISOLATION_PAD)} ${SHAPE_SECRET}`,
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

  // —— 第 141 批会审返工：动态文本的出口（绝对路径与秘密）——
  const privateWorktree = `${world.repo}\\.wao-worktrees\\run_leak_error`;
  {
    const b = builder("run_leak_error");
    head(b, ctx, { deliveryRequested: true });
    working(b, T0 + 3000);
    b.clock(T0 + 4000).add("run.error", {
      phase: "spawn",
      error: `spawn ${world.repo}\\node.exe ENOENT，cwd=${s.runDir}，worktree=${privateWorktree}，参考 ${OUTSIDE_WIN} 与 ${OUTSIDE_POSIX}，${EXACT_SECRET}`,
    });
    b.clock(T0 + 4500).add("run.state_change", { from: "running", to: "failed", reason: "failed" });
    s.write("run_leak_error", b.events);
  }
  {
    const b = builder("run_leak_brief");
    head(b, ctx, {
      deliveryRequested: true,
      prompt: `# 迁移说明\n仓库在 ${world.repo}，产物写到 ${s.runDir}\\out.json；\n外部参考 ${OUTSIDE_WIN} 与 ${OUTSIDE_POSIX}。\n运行 node "C:\\Program Files\\nodejs\\node.exe" --cwd=/d/projects/x --out=${s.runDir}\\o.json`,
    });
    working(b, T0 + 3000);
    terminal(b, T0 + 5000);
    s.write("run_leak_brief", b.events);
  }
  {
    const b = builder("run_leak_answer");
    head(b, ctx, { roleId: "researcher", prompt: "# 调研\n正文" });
    working(b, T0 + 3000);
    say(b, T0 + 4000, `看了 ${world.repo}\\src\\a.js，运行目录 ${s.runDir}，外部 ${OUTSIDE_WIN} 与 ${OUTSIDE_POSIX}。`);
    terminal(b, T0 + 5000);
    s.write("run_leak_answer", b.events);
  }
  {
    const leakCommand = `node ${world.repo}\\scripts\\check.js ${OUTSIDE_WIN}`;
    const verification = {
      status: "passed", commands: [leakCommand], verifiedCommit: world.commitFor("run_leak_cmd", world.deliveryOne),
      results: [{ index: 0, command: leakCommand, exitCode: 0, timedOut: false, durationMs: 5 }],
    };
    s.write("run_leak_cmd", deliveredRun("run_leak_cmd", world, ctx, { outcomeOver: { verification } }).events);
  }
  // 具名不可验证：原因文本脱敏后显示（带路径与精确秘密）。
  s.write("run_unavail_reason", deliveredRun("run_unavail_reason", world, ctx, {
    status: "unavailable",
    outcomeOver: {
      verification: {
        status: "unavailable", commands: [], results: [], verifiedCommit: world.commitFor("run_unavail_reason", world.deliveryOne),
        unavailableReason: `无法验证：缺少 ${world.repo}\\scripts\\verify.js（${EXACT_SECRET}）`,
      },
    },
  }).events);
  // 标题 / 副标题 / 项目名：精确值秘密（含跨在标题上限处的）。
  world.beta = { slug: "beta-22222222", name: `Beta ${EXACT_SECRET}`, key: join(world.base, "beta-repo") };
  mkdirSync(join(s.runDir, "projects", world.beta.slug), { recursive: true });
  writeFileSync(
    join(s.runDir, "projects", world.beta.slug, ".project.json"),
    JSON.stringify({ key: world.beta.key, slug: world.beta.slug, displayName: world.beta.name, rulesVersion: "td190-r3", createdAt: iso(T0), aliases: [] }),
    "utf8",
  );
  {
    const b = builder("run_leak_title");
    head(b, ctx, { project: world.beta, roleId: "auditor", prompt: `${EXACT_SECRET} 先跑冒烟\n正文` });
    working(b, T0 + 3000);
    say(b, T0 + 4000, "完成");
    terminal(b, T0 + 5000);
    s.write("run_leak_title", b.events, join(s.runDir, "projects", world.beta.slug));
  }
  {
    const b = builder("run_leak_child");
    head(b, ctx, {
      at: T0 + 60_000, project: world.beta, deliveryRequested: true, prompt: `${EXACT_SECRET} 继续修\n细节`,
      continuation: { parentRunId: "run_leak_title", rootRunId: "run_leak_title" },
    });
    working(b, T0 + 63_000);
    terminal(b, T0 + 65_000);
    s.write("run_leak_child", b.events, join(s.runDir, "projects", world.beta.slug));
  }
  {
    const b = builder("run_leak_title_straddle");
    head(b, ctx, { project: world.beta, roleId: "auditor", prompt: `${"x".repeat(OWNER_TITLE_MAX_CHARS - 5)} ${EXACT_SECRET} 尾巴\n正文` });
    working(b, T0 + 3000);
    terminal(b, T0 + 5000);
    s.write("run_leak_title_straddle", b.events, join(s.runDir, "projects", world.beta.slug));
  }

  // —— 第 141 批会审返工：交付物 kind、验证结果、会审标记、交付事实与仓库的对账 ——
  // 调研角色 + 请求了交付、没有交付事实：仍是调研（deliveryRequested 只表示意图）。
  {
    const b = builder("run_research_requested");
    head(b, ctx, { roleId: "researcher", deliveryRequested: true, prompt: "# 调研并交付\n正文" });
    working(b, T0 + 3000);
    say(b, T0 + 4000, "调研结论：用游标分页。");
    terminal(b, T0 + 5000);
    s.write("run_research_requested", b.events);
  }
  // 历史交付：没有"请求交付"的标记，但转录里有绑定的交付事实 → 仍是写代码交付物。
  s.write("run_hist_delivery", deliveredRun("run_hist_delivery", world, ctx, { head: { deliveryRequested: false } }).events);
  // 还在待验证的 created 引用里夹带了执行结果：不能当成绑定的验证结果。
  {
    const forged = {
      status: "pending", commands: ["npm test"], verifiedCommit: world.commitFor("run_pending_results", world.deliveryOne),
      results: [{ index: 0, command: "npm test", exitCode: 0, timedOut: false, durationMs: 1 }],
    };
    const b = builder("run_pending_results");
    head(b, ctx, { deliveryRequested: true });
    working(b, T0 + 3000);
    terminal(b, T0 + 5000);
    created(b, T0 + 6000, world, { verification: forged });
    s.write("run_pending_results", b.events);
  }
  // 普通（非会审席）任务书正文里引用了会审固定合同的标记：正文不能被截断。
  s.write("run_quotes_marker", (() => {
    const b = builder("run_quotes_marker");
    head(b, ctx, { prompt: `# 说明\n文档里提到 ${JSON.stringify(CONSULT_SEAT_CONTRACT_MARKER)} 这段标记，\n后面的正文必须还在。${CONSULT_SEAT_CONTRACT_MARKER}${CONSULT_SEAT_CONTRACT_TEXT}\n结尾说明` });
    working(b, T0 + 3000);
    terminal(b, T0 + 5000);
    return b.events;
  })());
  // 清单里列了基线已有、这次没改的图片：清单与实际变更对不上。
  {
    const listed = [...world.filesOne, "assets/base.png"].sort();
    s.write("run_image_forged", deliveredRun("run_image_forged", world, ctx, {
      title: "出图（清单夹带未变更的图片）", head: { taskType: "image" }, createdOver: { changedFiles: listed }, outcomeOver: { changedFiles: listed },
    }).events);
  }
  // 普通作者写的普通提交冒充交付：树、父提交、清单、提交说明都对，只有作者与提交者不是 WAO 打包身份。
  {
    const tree = git(world.repo, "rev-parse", `${world.deliveryOne}^{tree}`);
    const ordinary = git(world.repo, "commit-tree", tree, "-p", world.baseCommit, "-m", deliveryCommitMessage("run_ordinary_commit"));
    world.ordinaryCommit = ordinary;
    s.write("run_ordinary_commit", deliveredRun("run_ordinary_commit", world, ctx, {
      title: "普通提交冒充交付", head: { taskType: "image" },
      createdOver: { deliveryCommit: ordinary, verification: { status: "pending", commands: ["npm test"], verifiedCommit: ordinary, results: [] } },
      outcomeOver: {
        deliveryCommit: ordinary,
        verification: { status: "passed", commands: ["npm test"], results: [{ index: 0, command: "npm test", exitCode: 0, timedOut: false, durationMs: 1 }], verifiedCommit: ordinary },
      },
    }).events);
  }
  // 候选提交会换的写代码运行：测试里改写成 delivery two 且只剩 created（正在验证）。
  s.write("run_swap_detail", deliveredRun("run_swap_detail", world, ctx, { title: "换候选（详情）" }).events);
  // 新转录有新提交、但缺请求标记：交付轴不能回退到快照里的旧提交（测试里改写成 delivery two）。
  s.write("run_axis_nomarker", deliveredRun("run_axis_nomarker", world, ctx, { title: "缺请求标记" }).events);
  // 租约心跳：比最近一次 worker 事件早（lastVitalAt 取较晚的事件，lastHeartbeatAt 只取心跳）。
  writeFileSync(join(s.runDir, ".owner-run_wait_no_delivery"), JSON.stringify({ pid: 4242, heartbeatAt: NOW - 120_000, claimedAt: iso(NOW), nonce: "n" }), "utf8");

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
  // 仓库、运行目录、临时根、工作树，以及正文 / 答复 / 诊断 / 命令里出现过的外部路径。
  const raw = [W.repo, W.store.runDir, W.base, `${W.repo}\\.wao-worktrees`, OUTSIDE_WIN, OUTSIDE_POSIX, "/opt/outside"];
  return [...raw, ...raw.map((p) => JSON.stringify(p).slice(1, -1))];
}
/** 没有隔离违规例外的响应里，不应出现任何盘符 / UNC / 以斜杠开头的绝对路径。 */
const ABSOLUTE_PATH_IN_JSON = /[A-Za-z]:(?:\\\\|\\|\/)[^\s"]|\\\\\\\\[^\s"]|(?:^|[\s"(])\/[A-Za-z][^\s"]*\/[^\s"]/;
function assertNoAbsolutePath(response) {
  const match = ABSOLUTE_PATH_IN_JSON.exec(response.body);
  assert.equal(match, null, `响应里有绝对路径：${match?.[0]}（…${response.body.slice(Math.max(0, (match?.index ?? 0) - 30), (match?.index ?? 0) + 60)}）`);
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
  assert.equal(d.delivery.commit, commitOne("run_code_pass"));
  assert.equal(d.delivery.awaitingDecision, true, "收口、待裁决、没被取代");
  assert.deepEqual(d.delivery.decision, { result: null, decidedAt: null, supersededByRunId: null });
  assert.deepEqual(d.delivery.round, { number: 1, complete: true, rootRunId: "run_code_pass", continuesRunId: null, continuesDecision: null });

  const dv = d.deliverable;
  assert.equal(dv.kind, "code");
  assert.equal(dv.state, "bound");
  assert.equal(dv.reason, null);
  assert.deepEqual(dv.commit, { hash: commitOne("run_code_pass"), source: "system_observed" });
  assert.equal(dv.files.source, "system_observed");
  assert.equal(dv.files.total, W.filesOne.length);
  assert.equal(dv.files.truncated, false);
  assert.deepEqual(dv.files.items.map((f) => f.path), W.filesOne, "序号 = changedFiles 的下标，路径是仓库相对路径");
  const byPath = new Map(dv.files.items.map((f) => [f.path, f]));
  assert.deepEqual(byPath.get("src/a.js"), { index: W.filesOne.indexOf("src/a.js"), path: "src/a.js", added: 3, deleted: 1, binary: false });
  assert.deepEqual(byPath.get("docs/notes.md"), { index: W.filesOne.indexOf("docs/notes.md"), path: "docs/notes.md", added: 2, deleted: 0, binary: false });
  assert.deepEqual(byPath.get("assets/logo.png"), { index: W.filesOne.indexOf("assets/logo.png"), path: "assets/logo.png", added: null, deleted: null, binary: true }, "二进制文件写二进制");

  assert.equal(dv.verification.source, "system_observed");
  assert.equal(dv.verification.boundCommit, commitOne("run_code_pass"));
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
  assert.deepEqual(Object.keys(d).sort(), ["brief", "consult", "deliverable", "delivery", "generatedAt", "health", "identity", "refSeq", "run", "runId", "status"]);
  assert.deepEqual(Object.keys(d.identity).sort(), ["elapsedMs", "laneKey", "project", "roleId", "startedAt", "subtitle", "taskType", "title"]);
  assert.deepEqual(Object.keys(d.health).sort(), ["failure", "lastEffectAt", "lastHeartbeatAt", "lastProcessActiveAt", "lastVitalAt", "liveness"]);
  assert.deepEqual(Object.keys(d.run).sort(), ["stage", "stageAgeMs", "stageSince", "state", "terminalAt"]);
  assert.deepEqual(Object.keys(d.delivery).sort(), [
    "ambiguous", "awaitingDecision", "branchPresent", "commit", "decision", "isolationFailure", "packagingFailure", "round", "settledAt", "settlement", "verification",
  ]);
  assert.deepEqual(Object.keys(d.deliverable).sort(), ["commit", "files", "kind", "reason", "reviews", "state", "verification"]);
  assert.deepEqual(Object.keys(d.deliverable.verification).sort(), ["boundCommit", "commands", "failure", "setupCommands", "source", "status", "unavailableReason"]);
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
    // 快照里的交付摘要是"旧一代"：交付轴只取这一次读到的转录（下面各例给的 events），快照只供 branchPresent。
    delivery: {
      settlement: { status: "settled", reason: "delivery_settled" }, commit: "c".repeat(40),
      verification: { status: "passed", reverify: { status: "none", reason: null } },
      acceptance: { status: "pending", decidedAt: null }, settledAt: iso(T0 + 1000), ambiguous: false,
      packagingFailure: null, isolationFailure: null, branchPresent: true,
    },
    ...over,
  });
  // 这一次读到的转录：已请求交付、已终态、验证通过（待裁决）。
  const run = async (target, rows, extra = {}) => projectWorkerDetail({
    run: target, snapshot: { generatedAt: iso(NOW), consults: [], runs: rows }, runsById: new Map(rows.map((r) => [r.runId, r])),
    events: deliveredRun(target.runId, W, W.ctx).events, now: NOW, ...extra,
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

  // 交付事实自相矛盾（同一运行两个 created）：收口判不出 → 不下结论。
  const undet = row("run_settle_und");
  const conflicting = deliveredRun("run_settle_und", W, W.ctx);
  created(conflicting, T0 + 6500, W);
  const dUndet = await run(undet, [undet], { events: conflicting.events });
  assert.deepEqual(dUndet.delivery.settlement, { status: "undeterminable", reason: "delivery_facts_malformed" });
  assert.equal(dUndet.delivery.awaitingDecision, null);

  const none = await run(row("run_plain", { deliveryRequested: false, delivery: null }), [], { events: [] });
  assert.equal(none.delivery, null, "没请求交付就没有交付轴");
  assert.deepEqual(none.deliverable, { kind: "none", state: "none" });

  // 快照里有旧一代的交付摘要，但这一次读到的转录里没有请求交付：清空，不回退快照。
  const stale = row("run_stale");
  assert.equal((await run(stale, [stale], { events: [] })).delivery, null, "缺证据就清空，不沿用快照的旧提交");
  const live = await run(stale, [stale]);
  assert.equal(live.delivery.commit, live.deliverable.commit.hash, "有证据：交付轴与交付物同一个提交，取这一次读到的转录");
  assert.notEqual(live.delivery.commit, "c".repeat(40));
  assert.equal(live.delivery.branchPresent, true, "只有转录之外的事实（分支是否还在）沿用快照");
});

// ===== 4. 会审 =====

test("会审：席位的会审轴（本席状态、几席已到、是否收齐）与交付物（每席一行、结论分裂、席位缺席）", async () => {
  const d = await W.worker("run_seat_a");
  assert.equal(d.identity.taskType, "untyped", "会审席本批仍按读模型的类型（旧席位 untyped）");
  assert.equal(d.identity.laneKey, "sol");
  assert.deepEqual(d.consult, {
    consultId: W.consultId, createdAt: iso(NOW - 3000), reviewedRunId: "run_code_pass",
    thisSeat: { agentId: "sol", runState: "completed", replied: true }, seatsTotal: 3, seatsArrived: 2, complete: false,
  });
  assert.equal(d.deliverable.kind, "consult");
  assert.equal(d.deliverable.state, "bound");
  assert.equal(d.deliverable.q1Declared, true);
  assert.equal(d.deliverable.verdictsDiffer, true, "PASS 与 FIX_FIRST：两个以上不同的有效 Q1");
  assert.equal(d.deliverable.anyFixFirst, true);
  assert.equal(Object.hasOwn(d.deliverable, "split"), false, "旧字段 split 改名为 verdictsDiffer（另加 anyFixFirst）");
  assert.deepEqual(d.deliverable.rows, [
    { laneKey: "sol", agentId: "sol", runId: "run_seat_a", runState: "completed", q1: "PASS", replied: true, source: "worker_reported" },
    { laneKey: "astra", agentId: "astra", runId: "run_seat_b", runState: "completed", q1: "FIX_FIRST", replied: true, source: "worker_reported" },
    { laneKey: "kimi", agentId: "kimi", runId: "run_seat_gone", runState: "missing", q1: null, replied: null, source: "worker_reported" },
  ], "缺席的席位如实 missing、结论留空、有没有答复说不清（null）");
  // 任务书：跳过会审席的固定合同包装，视角片段属于任务书。
  assert.equal(d.brief.state, "present");
  assert.ok(d.brief.text.includes("会审任务书") && d.brief.text.includes("视角：看边界"));
  assert.ok(!d.brief.text.includes("会审席边界") && !d.brief.text.includes("你只负责逐问"), "固定合同不进任务书");
});

test("会审：被审运行（写代码）的交付物里列出对应的交付会审各席结论", async () => {
  const d = await W.worker("run_code_pass");
  const [review] = d.deliverable.reviews;
  assert.equal(review.consultId, W.consultId);
  assert.equal(review.verdictsDiffer, true);
  assert.equal(review.anyFixFirst, true);
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
    ["assets/pic-lossless.webp", "image/webp", WEBP_LOSSLESS_BYTES],
  ]) {
    const r = await W.get(artifactUrl("run_image", commitOne("run_image"), W.filesOne.indexOf(path)));
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
  for (const path of [
    "assets/icon.svg", "assets/fake.png", "assets/huge.png", "src/a.js", "docs/notes.md",
    "assets/forged-sig.png", "assets/forged-riff.webp", "assets/trunc.png", "assets/trunc.jpg", "assets/badlen.webp",
  ]) {
    const r = await W.get(artifactUrl("run_image", commitOne("run_image"), W.filesOne.indexOf(path)));
    assert.equal(r.status, 404, path);
    assert.deepEqual(jsonOf(r), { error: "not_found" });
    assertSafeHeaders(r);
  }
});

test("产物接口：提交号不符、序号越界、不存在的运行都拒绝；候选提交换了以后旧提交号与旧序号失效", async () => {
  const idx = W.filesOne.indexOf("assets/logo.png");
  assert.equal((await W.get(artifactUrl("run_image", commitTwo("run_image"), idx))).status, 404, "不是当前交付提交");
  assert.equal((await W.get(artifactUrl("run_image", "a".repeat(40), idx))).status, 404);
  assert.equal((await W.get(artifactUrl("run_image", commitOne("run_image"), W.filesOne.length))).status, 404, "序号刚好越界");
  assert.equal((await W.get(artifactUrl("run_image", commitOne("run_image"), 999_999))).status, 404);
  assert.equal((await W.get(artifactUrl("run_nobody", commitOne("run_nobody"), idx))).status, 404, "不存在的运行");
  assert.equal((await W.get(artifactUrl("run_wait_no_delivery", commitOne("run_wait_no_delivery"), 0))).status, 404, "没有交付的运行");
  assert.equal((await W.get(artifactUrl("run_no_repo", commitOne("run_no_repo"), idx))).status, 404, "项目仓库不明：不读");

  // 换候选：run_image_swap 先指向 delivery one（序号 0 = fake.png 一类），再整份改写成 delivery two。
  const swapIdx = W.filesOne.indexOf("assets/logo.png");
  assert.equal((await W.get(artifactUrl("run_image_swap", commitOne("run_image_swap"), swapIdx))).status, 200, "换之前正常");
  const b = builder("run_image_swap");
  head(b, W.ctx, { deliveryRequested: true, prompt: "# 出图（换候选）", taskType: "image" });
  working(b, T0 + 3000);
  terminal(b, T0 + 5000);
  b.clock(T0 + 6000).add("run.delivery_created", { delivery: deliveryRef("run_image_swap", W, { deliveryCommit: commitTwo("run_image_swap"), changedFiles: W.filesTwo, verification: { status: "pending", commands: [], verifiedCommit: commitTwo("run_image_swap"), results: [] } }) });
  W.store.write("run_image_swap", b.events);
  const otherIdx = W.filesTwo.indexOf("assets/other.png");
  assert.equal((await W.get(artifactUrl("run_image_swap", commitOne("run_image_swap"), swapIdx))).status, 404, "旧提交号失效：同一个序号不会指到另一份文件");
  assert.equal((await W.get(artifactUrl("run_image_swap", commitOne("run_image_swap"), otherIdx))).status, 404);
  const fresh = await W.get(artifactUrl("run_image_swap", commitTwo("run_image_swap"), otherIdx));
  assert.equal(fresh.status, 200, "新提交 + 新清单里的序号取得到");
  assert.ok(fresh.bytes.equals(PNG_1X1));
  assert.equal((await W.get(artifactUrl("run_image_swap", commitTwo("run_image_swap"), W.filesTwo.indexOf("docs/keep.md")))).status, 404, "不是图片");
});

// ===== 7. 对象已不可用 / 没有交付物 / 任务书缺失 =====

test("对象已不可用：项目仓库不明、提交不在仓库、交付事实矛盾——转录里的事实照给，读不到的只有增删行", async () => {
  const noRepo = await W.worker("run_no_repo");
  assert.equal(noRepo.identity.project, null);
  assert.equal(noRepo.deliverable.state, "unavailable");
  assert.equal(noRepo.deliverable.reason, "repository_unknown");
  assert.equal(noRepo.deliverable.commit.hash, commitOne("run_no_repo"));
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
  assert.deepEqual(d.deliverable, { kind: "none", state: "none" }, "只有交付意图、没有交付事实：none（照任务书）");
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
  // 会审席：prompt 只有实际追加的固定合同（没有任务书正文）也算缺失；普通运行同样的文字是正文，不剥。
  const onlyWrapper = builder("run_only_wrapper");
  head(onlyWrapper, W.ctx, { prompt: `${CONSULT_SEAT_CONTRACT_MARKER}${CONSULT_SEAT_CONTRACT_TEXT}` });
  const asSeat = async (events) => projectWorkerDetail({
    run: { runId: events[0].runId, availability: "ok", state: "completed", terminal: true, taskType: "untyped", deliveryRequested: false, liveness: "terminal", stage: "terminal", project: null, failure: null, delivery: null },
    snapshot: { consults: [{ consultId: "consult_x", reviewedRunId: null, q1Declared: false, seats: [{ agentId: "sol", runId: events[0].runId, runState: "completed", q1: null }] }], runs: [] },
    runsById: new Map(), events, now: NOW,
  });
  assert.equal((await asSeat(onlyWrapper.events)).brief.state, "missing", "会审席：只有固定合同 = 没有任务书");
  assert.equal((await detail(onlyWrapper.events)).brief.state, "present", "普通运行：同样的文字是正文，不剥");
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

test("隔离违规·畸形值不回显：非闭集 destination → null；非字符串 → null；控制字符再清、超长再限、秘密脱敏", async () => {
  const response = await W.get("/api/worker?runId=run_iso_malformed");
  assertSafeBody(response);
  const { isolation } = jsonOf(response).health.failure;
  assert.equal(isolation.reason, "file_written_physical_outside");
  assert.equal(isolation.destination, null, "闭集外的 destination 不回显");
  assert.equal(isolation.reportedPath, null, "数字不是字符串");
  assert.equal(isolation.escapedAt, null);
  assert.ok(!response.body.includes("etc/passwd"), "畸形的闭集值不回显");
  assert.ok(!/[\u0000-\u0008\u000b-\u001f]/.test(isolation.resolvedPath), "控制字符已清");
  assert.ok(isolation.resolvedPath.length <= 300, "再限一次长");
  assert.ok(isolation.resolvedPath.includes("[REDACTED"));
});

test("隔离违规·原因不在闭集：说不清是不是越界，目的地与路径一个都不给（与 MCP run_diagnose 同一道门）", async () => {
  const response = await W.get("/api/worker?runId=run_iso_badreason");
  assert.equal(response.status, 200);
  const d = jsonOf(response);
  assert.equal(d.health.failure.category, "workdir_escape");
  assert.equal(d.health.failure.isolation, null, "没有任何可放行的字段 → 不带隔离块");
  assert.ok(!response.body.includes("hacked-reason") && !response.body.includes("bad.txt"));
});

test("隔离违规·先脱敏、后限长：秘密（服务端 env 的精确值与形状）跨在 300 的截断点上也不留半截", async () => {
  const response = await W.get("/api/worker?runId=run_iso_straddle");
  assertSafeBody(response);
  const { isolation } = jsonOf(response).health.failure;
  assert.equal(isolation.reason, "file_written_lexical_outside");
  for (const field of ["reportedPath", "resolvedPath"]) {
    assert.ok(isolation[field].length <= 300, `${field} 不超限`);
    assert.ok(isolation[field].includes("[REDA"), `${field}：秘密先被替换成占位，再在上限处截断（实测 …${isolation[field].slice(-12)}）`);
    assert.ok(!/test-|sk-/.test(isolation[field].slice(250)), `${field} 没有半截秘密前缀`);
  }
});

test("projectIsolationViolation / isolationViolationDetail（看板与 MCP 共用）：闭集成员、escapedAt 只在 *_physical_outside、别的运行的事件不算", () => {
  assert.equal(projectIsolationViolation(null), null);
  assert.equal(projectIsolationViolation({ reason: "write_intent_physical_outside", escapedAt: "E:\\x" }).escapedAt, "E:\\x");
  assert.equal(projectIsolationViolation({ reason: "write_intent_physical_unresolved", escapedAt: "E:\\x" }).escapedAt, undefined);
  assert.equal(projectIsolationViolation({ escapedAt: "E:\\x" }), null, "没有 reason 就不给 escapedAt，也没有别的可信字段");
  const events = [
    { type: "run.isolation_violation", runId: "run_other", code: "workdir_escape", reason: "file_written_lexical_outside" },
    { type: "run.isolation_violation", runId: "run_mine", code: "something_else", reason: "file_written_lexical_outside" },
  ];
  assert.equal(isolationViolationDetail(events, "run_mine"), null, "别的运行 / 非安全码的事件不算");
  assert.equal(isolationViolationDetail([...events, { type: "run.isolation_violation", runId: "run_mine", code: "workdir_escape", reason: "file_written_lexical_outside", destination: "home" }], "run_mine").destination, "home");
  assert.equal(isolationViolationDetail("nope", "run_mine"), null);
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
    "run_silent", "run_starting", "run_nostage", "run_iso_physical", "run_iso_lexical", "run_iso_malformed", "run_iso_straddle",
    "run_leak_error", "run_leak_brief", "run_leak_answer", "run_leak_cmd", "run_unavail_reason", "run_leak_title", "run_leak_child",
    "run_leak_title_straddle", "run_code_stale_review", "run_code_review_big", "run_seat_c", "run_seat_d", "run_research_requested",
    "run_hist_delivery", "run_pending_results", "run_quotes_marker", "run_image_forged", "run_swap_detail", "run_ordinary_commit",
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

test("路由是闭集：服务源码里的 /api/ 路由恰好是这 10 个（第 141c 批起含 worker/activity 与 worker/event，第 144 批起含 worker/stream 三条二级路径）；其余 /api/* 固定 404", async () => {
  const src = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "../..", "src", "ownerDashboardServer.js"), "utf8");
  // 第 141c 批：路径允许一级或两级（`/api/worker/activity`）。旧正则只认一级，会让新路由悄悄漏出守卫。
  const declared = new Set([...src.matchAll(/"\/api\/([a-z]+(?:\/[a-z]+)?)"/g)].map((m) => m[1]));
  assert.deepEqual(
    [...declared].sort(),
    ["activity", "artifact", "attention", "overview", "runs", "worker", "worker/activity", "worker/event", "worker/stream", "workers"],
  );
  for (const url of [
    "/api/worker/extra", "/api/artifacts", "/api/Worker", "/api/", "/api/worker/", "/api/worker/activity/x", "/api/worker/Activity",
    "/api/worker/events", "/api/worker/activity/", "/api/workers/activity", "/api/activity/event",
    "/api/worker/stream/", "/api/worker/streams", "/api/worker/Stream",
  ]) {
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
    proveDelivery: async () => ({ ok: true, stats: new Map() }),
  });
  const paths = detail.deliverable.files.items.map((f) => f.path);
  assert.deepEqual(paths.slice(0, 4), Array(4).fill(OWNER_PATH_WITHHELD));
  assert.equal(paths[4], "ok/file.txt");
  assert.deepEqual(paths.slice(5, 8), Array(3).fill(OWNER_PATH_WITHHELD), "控制字符、数字、null");
  assert.ok(paths[8].includes("[REDACTED"), "路径里的秘密形状脱敏");

  const big = deliveredRun("run_many_files", W, W.ctx, { createdOver: { changedFiles: many }, outcomeOver: { changedFiles: many } }).events;
  const d = await projectWorkerDetail({
    run: { runId: "run_many_files", availability: "ok", state: "completed", terminal: true, taskType: "code", deliveryRequested: true, liveness: "terminal", stage: "terminal", project: null, failure: null, delivery: null },
    snapshot: { consults: [], runs: [] }, runsById: new Map(), events: big, now: NOW, repoRoot: W.repo, proveDelivery: async () => ({ ok: true, stats: new Map() }),
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
  assert.equal(bound.commit, commitOne("run_cd"));
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

test("sniffImageContentType 验结构、不只看前缀：真实可解码的小图放行；伪造的头、截断、长度对不上的一律拒绝", () => {
  // 正例：三种格式的真实小图（PNG 1×1、基线 JPEG 1×1、有损与无损 WebP 1×1）。
  for (const [bytes, type] of [[PNG_1X1, "image/png"], [JPEG_BYTES, "image/jpeg"], [WEBP_BYTES, "image/webp"], [WEBP_LOSSLESS_BYTES, "image/webp"]]) {
    assert.equal(sniffImageContentType(bytes), type, type);
  }
  const png = (rest) => Buffer.concat([PNG_1X1.subarray(0, 8), rest]);
  // 块头：4 字节长度 + 4 字节类型，后面接真实 IHDR 的 13 字节数据与 4 字节 CRC。
  const ihdr = (length, type) => Buffer.concat([Buffer.from([0, 0, 0, length]), Buffer.from(type, "latin1"), PNG_1X1.subarray(16, 33)]);
  // PNG：签名后必须紧跟长度为 13 的 IHDR 块。
  assert.equal(sniffImageContentType(png(Buffer.from(SVG_TEXT))), null, "签名 + SVG 文本");
  assert.equal(sniffImageContentType(png(Buffer.alloc(40))), null, "签名 + 全零");
  assert.equal(sniffImageContentType(png(Buffer.concat([ihdr(12, "IHDR"), Buffer.alloc(20)]))), null, "IHDR 长度不是 13");
  assert.equal(sniffImageContentType(png(Buffer.concat([ihdr(13, "IDAT"), Buffer.alloc(20)]))), null, "第一块不是 IHDR");
  assert.equal(sniffImageContentType(png(Buffer.concat([ihdr(13, "IHDR"), Buffer.alloc(20)]))), "image/png", "对照：长度 13 的 IHDR 块放行（结构只看签名后的第一块）");
  assert.equal(sniffImageContentType(PNG_1X1.subarray(0, 20)), null, "截在 IHDR 里面");
  assert.equal(sniffImageContentType(PNG_1X1.subarray(0, 8)), null, "只有签名");
  // JPEG：FF D8 之后必须是合法的标记段（FF + 标记码 + 不越过文件的段长）。
  const soi = Buffer.from([0xff, 0xd8]);
  assert.equal(sniffImageContentType(Buffer.concat([soi, Buffer.from(SVG_TEXT)])), null, "SOI + SVG 文本");
  assert.equal(sniffImageContentType(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(SVG_TEXT)])), null, "FF D8 FF 之后的 < 不是标记码");
  assert.equal(sniffImageContentType(JPEG_BYTES.subarray(0, 3)), null, "只有 FF D8 FF");
  assert.equal(sniffImageContentType(JPEG_BYTES.subarray(0, 10)), null, "第一个标记段被截断");
  assert.equal(sniffImageContentType(Buffer.concat([soi, Buffer.from([0xff, 0xe0, 0xff, 0xff]), Buffer.alloc(8)])), null, "段长越过文件末尾");
  assert.equal(sniffImageContentType(Buffer.concat([soi, Buffer.from([0xff, 0xe0, 0x00, 0x01]), Buffer.alloc(8)])), null, "段长小于 2");
  assert.equal(sniffImageContentType(Buffer.concat([soi, Buffer.from([0xff, 0x00, 0x00, 0x04]), Buffer.alloc(8)])), null, "00 不是标记码");
  assert.equal(sniffImageContentType(Buffer.concat([soi, Buffer.from([0xff, 0xd9, 0x00, 0x04]), Buffer.alloc(8)])), null, "EOI 不能开头");
  // WebP：RIFF 声明长度必须 = 文件长度 − 8；偏移 12 处是 VP8 / VP8L / VP8X。
  const withSize = (bytes, size) => Buffer.concat([bytes.subarray(0, 4), Buffer.from([size & 0xff, (size >> 8) & 0xff, 0, 0]), bytes.subarray(8)]);
  const riff = (size, rest) => Buffer.concat([Buffer.from("RIFF"), Buffer.from([size & 0xff, (size >> 8) & 0xff, 0, 0]), Buffer.from("WEBP"), rest]);
  assert.equal(sniffImageContentType(riff(0, Buffer.from(SVG_TEXT))), null, "RIFF + 零长度 + WEBP + SVG 文本");
  assert.equal(sniffImageContentType(withSize(WEBP_BYTES, WEBP_BYTES.length - 7)), null, "声明长度多 1");
  assert.equal(sniffImageContentType(withSize(WEBP_BYTES, WEBP_BYTES.length - 9)), null, "声明长度少 1");
  assert.equal(sniffImageContentType(withSize(WEBP_BYTES, WEBP_BYTES.length - 8)), "image/webp", "对照：声明长度 = 文件长度 − 8");
  assert.equal(sniffImageContentType(WEBP_BYTES.subarray(0, WEBP_BYTES.length - 4)), null, "截断（声明长度大于实际）");
  const vp9 = Buffer.from(WEBP_BYTES);
  vp9.write("VP9 ", 12, "latin1");
  assert.equal(sniffImageContentType(vp9), null, "偏移 12 处不是 VP8 / VP8L / VP8X");
  assert.equal(sniffImageContentType(riff(SVG_TEXT.length + 4, Buffer.from(SVG_TEXT))), null, "长度对得上但图像块不是 VP8*");
  const vp8x = Buffer.from(WEBP_BYTES);
  vp8x.write("VP8X", 12, "latin1");
  assert.equal(sniffImageContentType(vp8x), "image/webp", "VP8X 的 fourcc 也认（结构只看 RIFF 长度与首块 fourcc）");
});

test("proveDeliveryObjects：交付对象要对得上——提交类型、父提交 = 基线、实际变更清单 = changedFiles、提交说明 = wao-delivery: <runId>、作者与提交者 = WAO 打包身份；有界的只读 git 调用", async () => {
  const runId = "run_prove";
  const commit = W.commitFor(runId, W.deliveryOne);
  const input = { runId, repoRoot: W.repo, baseCommit: W.baseCommit, commit, changedFiles: W.filesOne };
  const prove = (over = {}, deps = {}) => createDeliveryProver(deps)({ ...input, ...over });
  const ok = await prove();
  assert.equal(ok.ok, true);
  assert.equal(ok.stats.get("src/a.js").added, 3, "证过的同时给出增删行");
  // 提交类型：树对象（40 位十六进制但不是提交）、不存在的对象。
  const tree = git(W.repo, "rev-parse", `${W.deliveryOne}^{tree}`);
  assert.deepEqual(await prove({ commit: tree }), { ok: false, reason: "unreadable" }, "不是提交对象");
  assert.deepEqual(await prove({ commit: "9".repeat(40) }), { ok: false, reason: "unreadable" }, "对象不存在");
  assert.deepEqual(await prove({ repoRoot: join(W.base, "not-a-repo") }), { ok: false, reason: "unreadable" });
  assert.deepEqual(await prove({ commit: "HEAD" }), { ok: false, reason: "unreadable" }, "不是规范提交号：不问 git");
  assert.deepEqual(await prove({ runId: "bad/id" }), { ok: false, reason: "unreadable" }, "runId 形状不对：不问 git");
  // 父提交必须恰好是基线：基线换成别的提交、合并提交（两个父）都不行。
  assert.deepEqual(await prove({ baseCommit: W.deliveryTwo }), { ok: false, reason: "mismatch" }, "父提交不是这个基线");
  const wao = (...extra) => gitAs(W.repo, WAO_IDENTITY_ENV, "commit-tree", tree, ...extra, "-m", deliveryCommitMessage(runId));
  assert.deepEqual(await prove({ commit: wao("-p", W.baseCommit, "-p", W.deliveryTwo) }), { ok: false, reason: "mismatch" }, "有两个父提交（说明与身份都对）");
  // 实际变更清单必须与 changedFiles 逐项相等（顺序无关）：多一项（基线已有、没改）、少一项、空清单、重复项。
  assert.deepEqual(await prove({ changedFiles: [...W.filesOne, "assets/base.png"] }), { ok: false, reason: "mismatch" });
  assert.deepEqual(await prove({ changedFiles: W.filesOne.slice(1) }), { ok: false, reason: "mismatch" });
  assert.deepEqual(await prove({ changedFiles: [] }), { ok: false, reason: "mismatch" });
  assert.deepEqual(await prove({ changedFiles: [...W.filesOne, W.filesOne[0]] }), { ok: false, reason: "mismatch" });
  assert.equal((await prove({ changedFiles: [...W.filesOne].reverse() })).ok, true, "顺序无关");
  // 归属：普通作者写的普通提交，即使父提交和清单都对，也被拒（修正二·4）。
  const ordinary = git(W.repo, "commit-tree", tree, "-p", W.baseCommit, "-m", deliveryCommitMessage(runId));
  assert.deepEqual(await prove({ commit: ordinary }), { ok: false, reason: "mismatch" }, "说明对、身份是普通作者");
  const asOrdinary = (env, message) => gitAs(W.repo, { ...WAO_IDENTITY_ENV, ...env }, "commit-tree", tree, "-p", W.baseCommit, "-m", message);
  assert.deepEqual(await prove({ commit: asOrdinary({ GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid" }, deliveryCommitMessage(runId)) }), { ok: false, reason: "mismatch" }, "只有作者不对");
  assert.deepEqual(await prove({ commit: asOrdinary({ GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" }, deliveryCommitMessage(runId)) }), { ok: false, reason: "mismatch" }, "只有提交者不对");
  assert.deepEqual(await prove({ commit: asOrdinary({ GIT_AUTHOR_EMAIL: "someone@example.invalid" }, deliveryCommitMessage(runId)) }), { ok: false, reason: "mismatch" }, "名字对、邮箱不对");
  assert.deepEqual(await prove({ commit: asOrdinary({}, "delivery one") }), { ok: false, reason: "mismatch" }, "身份对、说明不是 wao-delivery: <runId>");
  assert.deepEqual(await prove({ commit: W.commitFor("run_other", W.deliveryOne) }), { ok: false, reason: "mismatch" }, "说明绑定别的运行的 runId");
  assert.deepEqual(await prove({ commit: asOrdinary({}, `${deliveryCommitMessage(runId)}\n\n多出来的正文`) }), { ok: false, reason: "mismatch" }, "说明必须正好是这一行");
  assert.equal((await prove({ commit: asOrdinary({}, `${deliveryCommitMessage(runId)}\n`) })).ok, true, "对照：末尾换行不影响（与 delivery.js 同一个整体 trim）");
  // 每次 git 调用都是只读结构化参数，带超时与输出上限。
  const calls = [];
  const spy = async (args, repoRoot, opts) => { calls.push({ args, opts }); return runGitReadOnly(args, repoRoot, opts); };
  assert.equal((await prove({}, { runGitFn: spy })).ok, true);
  assert.ok(calls.length >= 4 && calls.every((c) => Number.isInteger(c.opts.timeoutMs) && c.opts.timeoutMs > 0 && c.opts.maxBuffer > 0));
  assert.ok(calls.every((c) => !c.args.some((a) => /^(commit|reset|checkout|add|stash|gc|prune|update-ref|branch|tag|push|fetch|config)$/.test(a))), "只读");
  // 证明走的是请求当刻的对象库：缓存的是增删行，不是"对象还在"这个结论（见 A3 的对象被清掉用例）。
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

// ===== 14. 第 141 批会审返工（A1–A5） =====

/** 一份独立的小世界（自己的运行目录与服务），给会改动磁盘形状的授权用例用，不碰共享世界 W。 */
async function miniWorld(repoKey = W.repo) {
  const store = makeStore(repoKey);
  const server = createOwnerDashboardServer({
    runDir: store.runDir, workspaceRoot: store.base, knownAgentIds: [], env: SERVER_ENV, nowFn: () => NOW,
  });
  const auth = { authorization: `Bearer ${server.token}` };
  return {
    store, server,
    get: (url) => drive(server.handler, { url, headers: auth }),
    refresh: () => server.refreshNow(),
    close: async () => { await server.close(); rmrfRetry(store.base); },
  };
}

// —— A1：动态文本的出口 ——

test("A1 动态文本的出口：诊断证据、任务书、调研答复、验证命令里的仓库根 / 运行目录 / 工作树 / 外部绝对路径都折成 …/末段，秘密先脱敏", async () => {
  const failed = await W.get("/api/worker?runId=run_leak_error");
  assert.equal(failed.status, 200);
  assertSafeBody(failed);
  assertNoAbsolutePath(failed);
  const facts = jsonOf(failed).health.failure.evidence.map((e) => e.fact).join("\n");
  assert.ok(facts.includes("…/node.exe"), `证据里的仓库路径折成末段（实测 ${facts}）`);
  assert.ok(facts.includes("…/spec.md") && facts.includes("…/run.sh"), "外部路径也折");
  assert.ok(facts.includes("[REDACTED:OWNER_TEST_API_KEY]"), "精确值秘密先脱敏");

  const brief = await W.get("/api/worker?runId=run_leak_brief");
  assertSafeBody(brief);
  assertNoAbsolutePath(brief);
  const text = jsonOf(brief).brief.text;
  assert.ok(text.startsWith("# 迁移说明") && text.includes("…/alpha-repo") && text.includes("…/out.json") && text.includes("…/spec.md") && text.includes("…/run.sh"), text);
  assert.ok(text.includes(`node "…/node.exe" --cwd=…/x --out=…/o.json`), `带引号的完整路径与参数值里的路径也折（实测 ${text}）`);
  assert.ok(!brief.body.includes("Program Files") && !brief.body.includes("/d/projects/x"));

  const answer = await W.get("/api/worker?runId=run_leak_answer");
  assertSafeBody(answer);
  assertNoAbsolutePath(answer);
  const reply = jsonOf(answer).deliverable.answer.text;
  assert.ok(reply.includes("…/a.js") && reply.includes("…/spec.md") && reply.includes("…/run.sh"), reply);

  const command = await W.get("/api/worker?runId=run_leak_cmd");
  assertSafeBody(command);
  assertNoAbsolutePath(command);
  assert.equal(jsonOf(command).deliverable.verification.commands[0].command, "node …/check.js …/spec.md");
});

test("A1 标题 / 副标题 / 项目名：精确值秘密也先脱敏（任务书首行、续修副标题、项目名、跨在标题上限处的）", async () => {
  const title = await W.get("/api/worker?runId=run_leak_title");
  assertSafeBody(title);
  const d = jsonOf(title);
  assert.equal(d.identity.title, "[REDACTED:OWNER_TEST_API_KEY] 先跑冒烟");
  assert.equal(d.identity.project.name, "Beta [REDACTED:OWNER_TEST_API_KEY]");

  const child = await W.get("/api/worker?runId=run_leak_child");
  assertSafeBody(child);
  assert.equal(jsonOf(child).identity.title, "[REDACTED:OWNER_TEST_API_KEY] 先跑冒烟", "续修子运行：主标题取谱系根");
  assert.equal(jsonOf(child).identity.subtitle, "[REDACTED:OWNER_TEST_API_KEY] 继续修", "本轮第一行作副标题");

  const straddle = await W.get("/api/worker?runId=run_leak_title_straddle");
  assertSafeBody(straddle);
  const clipped = jsonOf(straddle).identity.title;
  assert.ok(clipped.length <= OWNER_TITLE_MAX_CHARS);
  assert.ok(clipped.includes("[RE") && !/te/.test(clipped.slice(60)), `跨在标题上限处的秘密先被替换、再截断（实测 …${clipped.slice(-14)}）`);

  // 同一个读模型也喂列表：标题与项目名同样不带明文。
  for (const url of ["/api/workers", "/api/attention", "/api/overview"]) {
    const r = await W.get(url);
    assert.equal(r.status, 200, url);
    assert.ok(!r.body.includes(EXACT_SECRET), `${url} 不带精确值秘密`);
  }
});

test("A1 会审行：席位 runId 走 isValidRunId 并有长度上限，席位行有具名上限（总数照实给）", async () => {
  assert.equal(OWNER_RUN_ID_MAX_CHARS, 128);
  const response = await W.get("/api/worker?runId=run_code_review_big");
  assertSafeBody(response);
  assert.ok(!response.body.includes(W.hugeSeatRunId.slice(0, 200)), "8196 字符的席位 runId 不出接口");
  const [review] = jsonOf(response).deliverable.reviews;
  assert.equal(review.rows.length, OWNER_CONSULT_SEATS_MAX, "席位行有上限");
  assert.equal(review.rowsTruncated, true);
  assert.equal(review.rows[0].runId, null, "超长的 runId 不回显");
  for (const row of review.rows) assert.ok(row.runId === null || (row.runId.length <= OWNER_RUN_ID_MAX_CHARS && /^[A-Za-z0-9_-]+$/.test(row.runId)));
  assert.ok(review.rows.slice(1).every((row) => /^run_big_seat_\d+$/.test(row.runId)));
  const normal = jsonOf(await W.get("/api/worker?runId=run_code_pass")).deliverable.reviews[0];
  assert.equal(normal.rowsTruncated, false);
});

// —— A2：授权认实际目录，一次响应只用一代事实 ——

test("A2 授权认实际目录：本运行目录里的桶是联接到别处的 junction → 读不到对方的转录（详情与产物都 404）", async (t) => {
  const mine = await miniWorld();
  const other = makeStore(W.repo);
  const link = join(mine.store.runDir, "projects", "gamma-33333333");
  try {
    other.write("run_foreign", deliveredRun("run_foreign", W, W.ctx, { head: { taskType: "image" } }).events);
    mine.store.write("run_mine", deliveredRun("run_mine", W, W.ctx, { head: { taskType: "image" } }).events);
    try {
      symlinkSync(other.bucket, link, "junction");
    } catch {
      t.skip("此环境不允许创建 junction/symlink，无法构造桶联接");
      return;
    }
    assert.equal(await mine.refresh(), "ready");
    const idx = W.filesOne.indexOf("assets/logo.png");
    // 对照：本运行目录自己的运行照常可读。
    assert.equal((await mine.get("/api/worker?runId=run_mine")).status, 200);
    assert.equal((await mine.get(artifactUrl("run_mine", commitOne("run_mine"), idx))).status, 200);
    // 联接出去的桶里的转录：读模型枚举得到，但授权不认。
    const foreign = await mine.get("/api/worker?runId=run_foreign");
    assert.equal(foreign.status, 404);
    assert.deepEqual(jsonOf(foreign), { error: "not_found" });
    assert.equal((await mine.get(artifactUrl("run_foreign", commitOne("run_foreign"), idx))).status, 404);
  } finally {
    try { rmSync(link, { force: true }); } catch { /* 没建成 / 已删 */ }
    await mine.close();
    rmrfRetry(other.base);
  }
});

test("A2 授权：两次刷新之间新出现的冲突副本，刷新前就拒绝（与 resolveRun 同一口径：内容不同或读不出都拒绝，内容相同不算冲突）", async () => {
  const mini = await miniWorld();
  try {
    const events = deliveredRun("run_late", W, W.ctx, { head: { taskType: "image" } }).events;
    mini.store.write("run_late", events);
    assert.equal(await mini.refresh(), "ready");
    const idx = W.filesOne.indexOf("assets/logo.png");
    const worker = () => mini.get("/api/worker?runId=run_late");
    const artifact = () => mini.get(artifactUrl("run_late", commitOne("run_late"), idx));
    assert.equal((await worker()).status, 200);
    assert.equal((await artifact()).status, 200);

    // 内容相同的副本：不是冲突（刷新后也是 ok）。
    mini.store.write("run_late", events, mini.store.runDir);
    assert.equal((await worker()).status, 200, "同内容副本不冲突");
    // 内容不同的副本：刷新之前就 404。
    mini.store.write("run_late", deliveredRun("run_late", W, W.ctx, { title: "另一份", head: { taskType: "image" } }).events, mini.store.runDir);
    for (const r of [await worker(), await artifact()]) {
      assert.equal(r.status, 404);
      assert.deepEqual(jsonOf(r), { error: "not_found" });
    }
    // 副本读不出（同名的目录）：歧义，拒绝。
    rmSync(join(mini.store.runDir, "run_late.jsonl"), { force: true });
    mkdirSync(join(mini.store.runDir, "run_late.jsonl"));
    assert.equal((await worker()).status, 404, "读不出的副本");
    rmSync(join(mini.store.runDir, "run_late.jsonl"), { recursive: true, force: true });
    assert.equal((await worker()).status, 200, "副本没了：恢复");
  } finally {
    await mini.close();
  }
});

test("A2 一次响应只用一代事实：候选提交更换后，详情的交付轴与交付物同一个提交号、同一个验证状态", async () => {
  const before = await W.worker("run_swap_detail");
  assert.equal(before.delivery.commit, commitOne("run_swap_detail"));
  assert.equal(before.deliverable.commit.hash, commitOne("run_swap_detail"));
  assert.equal(before.delivery.verification.status, "passed");
  assert.equal(before.deliverable.verification.status, "passed");

  // 转录被改写成新候选（delivery two，验证失败），读模型还没有刷新：快照仍是旧一代。
  const next = { ...W, deliveryOne: W.deliveryTwo, filesOne: W.filesTwo };
  W.store.write("run_swap_detail", deliveredRun("run_swap_detail", next, W.ctx, { title: "换候选（详情）", status: "failed" }).events);
  const after = await W.worker("run_swap_detail");
  assert.equal(after.deliverable.commit.hash, commitTwo("run_swap_detail"), "交付物取请求当刻的转录");
  assert.equal(after.delivery.commit, commitTwo("run_swap_detail"), "交付轴与交付物同一代：提交号一致");
  assert.equal(after.delivery.verification.status, "failed");
  assert.equal(after.deliverable.verification.status, "failed", "验证状态一致");
  assert.equal(after.delivery.awaitingDecision, true);
  assert.equal(after.generatedAt, iso(NOW), "快照时刻不变：只有交付事实换成请求当刻的");
  // 产物接口用的也是这一代：新提交取得到，旧提交 404。
  const idx = W.filesTwo.indexOf("assets/other.png");
  assert.equal((await W.get(artifactUrl("run_swap_detail", commitTwo("run_swap_detail"), idx))).status, 200);
  assert.equal((await W.get(artifactUrl("run_swap_detail", commitOne("run_swap_detail"), idx))).status, 404);
});

// —— A3：产物要证明交付对象和文件清单 ——

test("A3 产物接口：清单里列了基线已有、这次没改的图片 → 404；详情如实标 unavailable（诚实的清单照常取到）", async () => {
  const listed = [...W.filesOne, "assets/base.png"].sort();
  for (const path of ["assets/base.png", "assets/logo.png"]) {
    const r = await W.get(artifactUrl("run_image_forged", commitOne("run_image_forged"), listed.indexOf(path)));
    assert.equal(r.status, 404, `${path}：清单与实际变更对不上，整份清单不可信`);
    assert.deepEqual(jsonOf(r), { error: "not_found" });
  }
  const d = await W.worker("run_image_forged");
  assert.equal(d.deliverable.state, "unavailable");
  assert.equal(d.deliverable.reason, "delivery_facts_conflict", "转录里的清单与仓库里的实际变更矛盾");
  assert.ok(d.deliverable.files.items.every((f) => f.added === null && f.deleted === null), "不采信：增删行不给");
  assert.equal((await W.get(artifactUrl("run_image", commitOne("run_image"), W.filesOne.indexOf("assets/logo.png")))).status, 200, "对照：诚实的清单照常");
});

test("修正二·4 交付证明含归属：普通作者的普通提交即使父提交与清单都对，产物 404、详情标 unavailable", async () => {
  const idx = W.filesOne.indexOf("assets/logo.png");
  const forged = await W.get(artifactUrl("run_ordinary_commit", W.ordinaryCommit, idx));
  assert.equal(forged.status, 404);
  assert.deepEqual(jsonOf(forged), { error: "not_found" });
  const d = await W.worker("run_ordinary_commit");
  assert.equal(d.deliverable.state, "unavailable");
  assert.equal(d.deliverable.reason, "delivery_facts_conflict", "转录声明的提交不是这个运行的 WAO 交付提交");
  assert.equal(d.deliverable.commit.hash, W.ordinaryCommit, "转录里的事实照给");
  assert.ok(d.deliverable.files.items.every((f) => f.added === null && f.deleted === null), "不采信：增删行不给");
  // 对照：同一份树、同一个清单，WAO 身份 + wao-delivery: <runId> 的提交照常取到。
  assert.equal((await W.get(artifactUrl("run_image", commitOne("run_image"), idx))).status, 200);
});

test("A3 对象被清掉后：缓存命中也如实反映——详情标 unavailable、产物 404", async () => {
  const gone = await miniWorld(null); // 项目 key = <base>/alpha-repo，正是 makeRepo 建仓库的位置
  const world = makeRepo(gone.store.base);
  try {
    const ctx = { alpha: gone.store.alpha };
    gone.store.write("run_gone", deliveredRun("run_gone", world, ctx, { head: { taskType: "image" } }).events);
    assert.equal(await gone.refresh(), "ready");
    const idx = world.filesOne.indexOf("assets/logo.png");
    const detail = async () => jsonOf(await gone.get("/api/worker?runId=run_gone")).deliverable;
    const before = await detail(); // 第一次：算出增删行并缓存
    assert.equal(before.state, "bound");
    const goneCommit = world.commitFor("run_gone", world.deliveryOne);
    assert.equal((await gone.get(artifactUrl("run_gone", goneCommit, idx))).status, 200);
    assert.equal((await detail()).state, "bound", "第二次走缓存");

    // 把交付对象从仓库里清掉（分支删光、立刻修剪不可达对象）。
    git(world.repo, "branch", "-q", "-D", "delivery-one", "delivery-two");
    git(world.repo, "reflog", "expire", "--expire=now", "--all");
    git(world.repo, "gc", "-q", "--prune=now");
    const after = await detail();
    assert.equal(after.state, "unavailable", "对象没了：缓存的增删行不能让它继续显示 bound");
    assert.equal(after.reason, "git_read_failed");
    assert.equal(after.commit.hash, goneCommit, "转录里的事实照给");
    assert.ok(after.files.items.every((f) => f.added === null), "增删行读不到如实 null");
    assert.equal((await gone.get(artifactUrl("run_gone", goneCommit, idx))).status, 404);
  } finally {
    await gone.close();
  }
});

// —— A5：侧栏的事实口径 ——

test("A5 最后心跳：lastHeartbeatAt 只取租约心跳（没有心跳证据 → null）；lastVitalAt 保持最后体征的原义", async () => {
  const live = await W.worker("run_wait_no_delivery");
  assert.equal(live.health.lastHeartbeatAt, iso(NOW - 120_000), "只取租约心跳");
  assert.equal(live.health.lastVitalAt, iso(NOW - 10_000), "最后体征 = 事件与心跳里较晚的（这里事件更晚）");
  for (const runId of ["run_silent", "run_code_pass", "run_starting"]) {
    assert.equal((await W.worker(runId)).health.lastHeartbeatAt, null, `${runId}：没有心跳证据`);
  }
  // 坏租约不提供心跳。
  const bad = await miniWorld();
  try {
    const b = builder("run_bad_lease");
    head(b, W.ctx, {});
    working(b, NOW - 60_000);
    say(b, NOW - 30_000, "在干活");
    bad.store.write("run_bad_lease", b.events);
    writeFileSync(join(bad.store.runDir, ".owner-run_bad_lease"), "{not json", "utf8");
    assert.equal(await bad.refresh(), "ready");
    const h = jsonOf(await bad.get("/api/worker?runId=run_bad_lease")).health;
    assert.equal(h.lastHeartbeatAt, null);
    assert.equal(h.lastVitalAt, iso(NOW - 30_000));
  } finally {
    await bad.close();
  }
});

test("A5 几席已到：按「已到终态且收到了答复」计数；席位的运行状态、答复与 Q1 各自单列", async () => {
  const c = await W.worker("run_seat_c"); // 完成但没有答复
  assert.deepEqual(c.consult, {
    consultId: W.staleConsultId, createdAt: iso(T0 + 5000), reviewedRunId: "run_code_stale_review",
    thisSeat: { agentId: "sol", runState: "completed", replied: false },
    seatsTotal: 3, seatsArrived: 1, complete: false,
  }, "只有 d（失败但有答复）算已到；c（完成但没有答复）与 e（还在跑）都不算");
  assert.deepEqual(c.deliverable.rows.map((r) => [r.laneKey, r.runState, r.q1, r.replied]), [
    ["sol", "completed", null, false],
    ["astra", "failed", "PASS", true],
    ["kimi", "running", null, false],
  ], "运行状态、Q1、有没有答复各自单列");
  const d = await W.worker("run_seat_d");
  assert.equal(d.consult.thisSeat.replied, true);
  assert.equal(d.consult.seatsArrived, 1);
  const first = await W.worker("run_seat_a");
  assert.equal(first.consult.seatsArrived, 2, "两席完成且有答复；缺席的 kimi 不算");
  assert.equal(first.consult.complete, false);
});

test("A5 分裂：verdictsDiffer（两个以上不同的有效 Q1）与 anyFixFirst 分开给，不与 Attention 的 consult_split 互相矛盾", async () => {
  const all = (await W.worker("run_seat_f")).deliverable;
  assert.equal(all.q1Declared, true);
  assert.equal(all.verdictsDiffer, false, "全员 FIX_FIRST：值没有不同");
  assert.equal(all.anyFixFirst, true, "但有 FIX_FIRST——Attention 的 consult_split（不同或任一 FIX_FIRST）会提醒");
  const passOnly = (await W.worker("run_seat_d")).deliverable;
  assert.deepEqual([passOnly.verdictsDiffer, passOnly.anyFixFirst], [false, false]);
  const mixed = (await W.worker("run_seat_a")).deliverable;
  assert.deepEqual([mixed.verdictsDiffer, mixed.anyFixFirst], [true, true]);
  // 被审运行上的同一组会审也是这两个字段。
  const failReview = (await W.worker("run_code_fail")).deliverable.reviews[0];
  assert.deepEqual([failReview.verdictsDiffer, failReview.anyFixFirst], [false, true]);
  assert.ok(!("split" in failReview));
  // 没声明 Q1：都不下结论。
  const rows = [{ agentId: "sol", runId: "run_x", runState: "completed", q1: null }];
  const d = await projectWorkerDetail({
    run: { runId: "run_x", availability: "ok", state: "completed", terminal: true, taskType: "untyped", deliveryRequested: false, liveness: "terminal", stage: "terminal", project: null, failure: null, delivery: null },
    snapshot: { consults: [{ consultId: "consult_x", reviewedRunId: null, q1Declared: false, seats: rows }], runs: [] }, runsById: new Map(), events: [], now: NOW,
  });
  assert.deepEqual([d.deliverable.q1Declared, d.deliverable.verdictsDiffer, d.deliverable.anyFixFirst], [false, null, null]);
});

test("A5 具名不可验证：显示脱敏后的不可验证原因（路径折叠、秘密先脱敏）；其余状态没有原因", async () => {
  const r = await W.get("/api/worker?runId=run_unavail_reason");
  assertSafeBody(r);
  assertNoAbsolutePath(r);
  const v = jsonOf(r).deliverable.verification;
  assert.equal(v.status, "unavailable");
  assert.equal(v.unavailableReason, "无法验证：缺少 …/verify.js（[REDACTED:OWNER_TEST_API_KEY]）");
  assert.equal((await W.worker("run_code_unavail")).deliverable.verification.unavailableReason, "no runnable verification");
  for (const runId of ["run_code_pass", "run_code_fail", "run_code_pending"]) {
    assert.equal((await W.worker(runId)).deliverable.verification.unavailableReason, null, runId);
  }
});

test("A5 执行结果：只取绑定的验证结果事件——还在待验证的 created 引用里带的执行结果不算", async () => {
  const d = await W.worker("run_pending_results");
  assert.equal(d.deliverable.verification.status, "pending");
  assert.deepEqual(d.deliverable.verification.commands, [{ index: 0, command: "npm test", result: null }], "有声明的命令，没有绑定的结果");
  // 对照：有绑定的验证结果事件时照常给。
  assert.deepEqual((await W.worker("run_code_pass")).deliverable.verification.commands, [{ index: 0, command: "npm test", result: { exitCode: 0, timedOut: false, durationMs: 4321 } }]);
});

test("A5 任务书跳过固定合同：只对会审席、只剥实际追加的那段后缀；普通任务书正文里引用标记不截断", async () => {
  // 会审席：标记 + 固定句 + 声明字段段，整段后缀都不进任务书；视角片段属于任务书。
  const seat = jsonOf(await W.get("/api/worker?runId=run_seat_a")).brief;
  assert.equal(seat.text, "# 会审任务书\n## Q1 是否可行\n视角：看边界");
  // 反例：普通（非会审席）任务书正文里引用了标记、还有标记 + 固定句——一个字都不能少。
  const plain = jsonOf(await W.get("/api/worker?runId=run_quotes_marker")).brief;
  assert.equal(plain.truncated, false);
  assert.ok(plain.text.includes("后面的正文必须还在。"), "标记之前的正文在");
  assert.ok(plain.text.includes("结尾说明"), "标记之后的正文也在");
  assert.ok(plain.text.includes("会审席边界"), "引用的标记本身是正文");
  // 会审席的正文里也引用了标记：只剥最后那段实际追加的后缀。
  const detail = async (prompt) => {
    const events = builder("run_seat_quote");
    head(events, W.ctx, { prompt });
    return projectWorkerDetail({
      run: { runId: "run_seat_quote", availability: "ok", state: "completed", terminal: true, taskType: "untyped", deliveryRequested: false, liveness: "terminal", stage: "terminal", project: null, failure: null, delivery: null },
      snapshot: { consults: [{ consultId: "consult_q", reviewedRunId: null, q1Declared: true, declaredFields: DECLARED_Q1, seats: [{ agentId: "sol", runId: "run_seat_quote", runState: "completed", q1: null }] }], runs: [] },
      runsById: new Map(), events: events.events, now: NOW,
    });
  };
  const quoted = `# 任务\n正文里引用 ${CONSULT_SEAT_CONTRACT_MARKER}${CONSULT_SEAT_CONTRACT_TEXT} 这一段，\n后面还有内容`;
  assert.equal((await detail(`${quoted}${W.seatSuffix}`)).brief.text, quoted, "只剥实际追加的后缀");
  // 标记之后不是固定合同（不是实际追加的后缀）：不剥。
  const notContract = `# 任务\n${CONSULT_SEAT_CONTRACT_MARKER}这不是固定合同，是正文\n更多`;
  assert.equal((await detail(notContract)).brief.text, notContract);
  // 固定句之后追加了不属于声明字段段的内容：不剥。
  const tail = `# 任务\n正文${CONSULT_SEAT_CONTRACT_MARKER}${CONSULT_SEAT_CONTRACT_TEXT}\n额外的一段`;
  assert.equal((await detail(tail)).brief.text, tail);
});

test("A5 交付物 kind：会审席 > 生图 > 有绑定的交付事实（写代码）> 调研角色 > none；deliveryRequested 只表示意图", async () => {
  assert.equal((await W.worker("run_seat_a")).deliverable.kind, "consult");
  assert.equal((await W.worker("run_image")).deliverable.kind, "image");
  const research = await W.worker("run_research_requested");
  assert.equal(research.deliverable.kind, "research", "调研角色 + 请求了交付、没有交付事实：仍是调研");
  assert.equal(research.deliverable.answer.text, "调研结论：用游标分页。");
  const historical = await W.worker("run_hist_delivery");
  assert.equal(historical.deliverable.kind, "code", "没有请求标记的历史交付：有绑定的交付事实就是写代码");
  assert.equal(historical.deliverable.state, "bound");
  assert.equal(historical.deliverable.commit.hash, commitOne("run_hist_delivery"));
  const requestedNothing = await W.worker("run_wait_no_delivery");
  assert.deepEqual(requestedNothing.deliverable, { kind: "none", state: "none" }, "只有交付意图（deliveryRequested）、没有交付事实：none，不当作写代码");
  assert.equal(requestedNothing.delivery.commit, null, "交付轴也没有提交号");
  assert.deepEqual((await W.worker("run_untyped")).deliverable, { kind: "none", state: "none" });
  // 调研角色真的产出了交付事实：有绑定的交付事实在前。
  const both = await projectWorkerDetail({
    run: { runId: "run_rd", availability: "ok", state: "completed", terminal: true, taskType: "research", deliveryRequested: true, liveness: "terminal", stage: "terminal", project: null, failure: null, delivery: null },
    snapshot: { consults: [], runs: [] }, runsById: new Map(),
    events: deliveredRun("run_rd", W, W.ctx).events, now: NOW, repoRoot: W.repo,
    proveDelivery: async () => ({ ok: true, stats: new Map() }),
  });
  assert.equal(both.deliverable.kind, "code");
});

test("A5 deliverable.reviews：每场会审带 afterCurrentDelivery（会审创建时间不早于当前交付的 created 事件）", async () => {
  const fresh = (await W.worker("run_code_pass")).deliverable.reviews;
  assert.deepEqual(fresh.map((r) => [r.consultId, r.afterCurrentDelivery]), [[W.consultId, true]], "会审在交付之后");
  const stale = (await W.worker("run_code_stale_review")).deliverable.reviews;
  assert.deepEqual(stale.map((r) => [r.consultId, r.afterCurrentDelivery]), [[W.staleConsultId, false]], "会审早于当前交付：意见针对的是更早的候选");
  // 恰好同一时刻算"不早于"；没有当前交付 / 时间读不出 → null（不替它下结论）。
  const events = deliveredRun("run_edge", W, W.ctx).events;
  const createdAt = events.find((e) => e.type === "run.delivery_created").ts;
  const withConsult = async (consultCreatedAt, evs = events) => (await projectWorkerDetail({
    run: { runId: "run_edge", availability: "ok", state: "completed", terminal: true, taskType: "code", deliveryRequested: true, liveness: "terminal", stage: "terminal", project: null, failure: null, delivery: null },
    snapshot: { consults: [{ consultId: "consult_e", reviewedRunId: "run_edge", createdAt: consultCreatedAt, q1Declared: false, seats: [] }], runs: [] },
    runsById: new Map(), events: evs, now: NOW, repoRoot: W.repo, proveDelivery: async () => ({ ok: true, stats: new Map() }),
  })).deliverable.reviews[0].afterCurrentDelivery;
  assert.equal(await withConsult(createdAt), true);
  assert.equal(await withConsult(iso(Date.parse(createdAt) - 1)), false);
  assert.equal(await withConsult(iso(Date.parse(createdAt) + 1)), true);
  assert.equal(await withConsult(null), null, "会审时间读不出");
  // 没有当前交付（交付事实自相矛盾：同一运行两个 created）：没有"当前交付的 created 事件时间"可比。
  const conflicting = deliveredRun("run_edge", W, W.ctx);
  created(conflicting, T0 + 6500, W);
  assert.equal(await withConsult(createdAt, conflicting.events), null, "没有当前交付");
});
// —— 第 141 批修正二 ——

test("修正二·2 交付轴与交付物出自同一次读取：新转录有新提交但缺请求标记 → 同一响应里只出现一个提交号，不回退快照里的旧提交", async () => {
  const before = await W.worker("run_axis_nomarker");
  assert.equal(before.delivery.commit, commitOne("run_axis_nomarker"), "对照：快照那一代是旧提交");
  // 转录被改写成新候选（delivery two）：有 created / 验证事件，但 run.background_submitted 没有 deliveryRequested。
  const next = { ...W, deliveryOne: W.deliveryTwo, filesOne: W.filesTwo };
  W.store.write("run_axis_nomarker", deliveredRun("run_axis_nomarker", next, W.ctx, {
    title: "缺请求标记", head: { deliveryRequested: false },
  }).events);
  const response = await W.get("/api/worker?runId=run_axis_nomarker");
  assert.equal(response.status, 200);
  const d = jsonOf(response);
  assert.equal(d.deliverable.commit.hash, commitTwo("run_axis_nomarker"), "交付物取请求当刻的转录");
  assert.equal(d.delivery, null, "交付轴同样取这一次读到的事实：没有请求标记就没有交付轴，不回退快照");
  assert.ok(!response.body.includes(commitOne("run_axis_nomarker")), "整份响应里没有旧提交号");
  const commits = new Set(response.body.match(/\b[0-9a-f]{40}\b/g));
  assert.deepEqual([...commits], [commitTwo("run_axis_nomarker")], "同一响应里只出现一个提交号");
});

test("修正二·5 会审席任务书后缀：按组记录里实际声明的 fields（含多行候选）重建后精确匹配再剥；匹配不上保留全文", async () => {
  // 端到端：记录声明了多行候选（MCP schema 接受任意非空字符串），写入端同一个构造函数追加后缀。
  const matched = await W.get("/api/worker?runId=run_seat_m");
  assertSafeBody(matched);
  assert.equal(jsonOf(matched).brief.text, W.multiBody, "整段后缀（含多行候选的声明段）都剥掉");
  assert.equal(jsonOf(matched).brief.truncated, false);
  // 同一组里另一席的 prompt 按别的声明生成，与记录对不上：不剥，全文保留（含固定合同）。
  const other = jsonOf(await W.get("/api/worker?runId=run_seat_n")).brief.text;
  assert.ok(other.startsWith(W.multiBody) && other.includes("会审席边界") && other.includes("结论字段格式"), other);

  // 直接投影：多行候选、声明顺序、没有声明、声明段缺失，各给一例。
  const body = "# 任务\n正文第一行\n正文第二行";
  const detail = async (prompt, declaredFields) => (await projectWorkerDetail({
    run: { runId: "run_seat_dir", availability: "ok", state: "completed", terminal: true, taskType: "untyped", deliveryRequested: false, liveness: "terminal", stage: "terminal", project: null, failure: null, delivery: null },
    snapshot: { consults: [{ consultId: "consult_d", reviewedRunId: null, q1Declared: false, ...(declaredFields === undefined ? {} : { declaredFields }), seats: [{ agentId: "sol", runId: "run_seat_dir", runState: "completed", q1: null }] }], runs: [] },
    runsById: new Map(),
    events: (() => { const b = builder("run_seat_dir"); head(b, W.ctx, { prompt }); return b.events; })(),
    now: NOW,
  })).brief.text;
  const multi = { Q1: ["PASS", "有\n换行的候选"], Q2: ["A\r\nB", "C"] };
  assert.equal(await detail(buildConsultSeatPrompt(body, multi), multi), body, "多行候选（\\n 与 \\r\\n）");
  assert.equal(await detail(buildConsultSeatPrompt(body, undefined), undefined), body, "没有声明：只剥固定合同");
  assert.equal(await detail(buildConsultSeatPrompt(body, { Q2: ["x"], Q1: ["y"] }), { Q1: ["y"], Q2: ["x"] }), buildConsultSeatPrompt(body, { Q2: ["x"], Q1: ["y"] }), "声明顺序不同 = 重建出的后缀对不上，不剥");
  const withSection = buildConsultSeatPrompt(body, DECLARED_Q1);
  assert.equal(await detail(withSection, undefined), withSection, "记录里没有声明、prompt 却带声明段：不剥");
  assert.equal(await detail(withSection, { Q1: ["PASS"] }), withSection, "候选对不上：不剥");
  assert.equal(await detail(buildConsultSeatPrompt(body, undefined), DECLARED_Q1), buildConsultSeatPrompt(body, undefined), "记录有声明、prompt 没有声明段：不剥");
  assert.equal(await detail(`${withSection}\n多出来的尾巴`, DECLARED_Q1), `${withSection}\n多出来的尾巴`, "后缀后面还有内容：不是实际追加的后缀，不剥");
});