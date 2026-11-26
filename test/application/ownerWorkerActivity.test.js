// test/application/ownerWorkerActivity.test.js
//
// 第 141c 批（决定 0131 §3，实现计划 A3）：Owner 看板 worker 侧栏 Activity 页签用的两个只读接口
// GET /api/worker/activity（有界事件页，向上翻页）与 GET /api/worker/event（按 runId#seq 取某条事件
// 全文的有界分页）。本批的 Owner 投影另起一份，与 Lead 侧 run_activity 的游标、路径、输出契约分开。
//
// 夹具纪律：运行目录与转录全部建在 os.tmpdir() 下，转录写真实事件形状（run.event 的 message /
// command / tool_use / tool_result / file_written / runtime_activity / thinking、run.state_change、
// run.error、run.isolation_violation），绝不读仓库的 runs/。读模型是真实的 createOwnerReadModel
// （经服务的缺省接线）。鉴权、参数闭集、方法与固定错误体的守卫用例在
// test/isolation-infra/ownerDashboardApi.test.js。
//
// 覆盖面（每条声称对应一个能证伪它的用例）：
//   - 最近 200 条；beforeSeq 向上翻页，页与页之间不重不漏；limit 的缺省与上限
//   - 长输出头 20 + 尾 20 + 总行数；中等长度不丢行；助手消息前 6 行；CRLF 不留替换符
//   - 连续运行时活动折叠（seq 区间、条数、最后一种状态）；中间的非时间线事件不打断，别的事件与缺口打断
//   - 三种"看不到"：被筛掉（filter）、被折叠、真的缺失（缺口记录）；筛掉的与时间线之外的不算缺失
//   - seq 的真实性：旧档没有事件号、事件号重复、倒退都明确标出，缺口不把已存在的号当缺失
//   - 写文件路径：工作树内给相对路径（大小写、段边界），树外 / 判不清 [path_withheld]；增删行未知
//   - 命令退出码（线上给的、可信后端推断的、还没有）；输出归属（命令输出 / 工具结果）
//   - 隔离违规照共用投影；错误全文有界
//   - 全文分页：页数、末页长度、多字节不被劈开、越界 / 不适用 / 重复号被拒
//   - 秘密（精确值与形状）在摘要、头尾、全文、跨页边界处都被替换；绝对路径折成末段；控制字符清掉

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rmrfRetry } from "../_rmrfHelper.mjs";
import { createOwnerDashboardServer } from "../../src/ownerDashboardServer.js";
import { isolationViolationDetail } from "../../src/diagnosis.js";
import { createOwnerReadModel } from "../../src/application/ownerReadModel.js";
import * as Activity from "../../src/application/ownerWorkerActivity.js";
import {
  OWNER_ACTIVITY_CODES,
  OWNER_ACTIVITY_FILTERS,
  OWNER_ACTIVITY_LABEL_MAX_CHARS,
  OWNER_ACTIVITY_LIMIT_DEFAULT,
  OWNER_ACTIVITY_LIMIT_MAX,
  OWNER_ACTIVITY_LINE_MAX_CHARS,
  OWNER_ERROR_MAX_CHARS,
  OWNER_EVENT_PAGE_MAX_BYTES,
  OWNER_EVENT_PARTS,
  OWNER_MESSAGE_HEAD_LINES,
  OWNER_OUTPUT_HEAD_LINES,
  OWNER_OUTPUT_TAIL_LINES,
  OWNER_SEQ_STATES,
  projectWorkerActivity,
  projectWorkerEvent,
} from "../../src/application/ownerWorkerActivity.js";
// 第 141c 批修正一新增的导出：用命名空间取，旧实现上这些是 undefined（对应用例按各自的断言红，而不是整份文件链接失败）。
const {
  OWNER_ACTIVITY_FULL_ALWAYS_MAX_CHARS,
  OWNER_ACTIVITY_PAGE_MAX,
  OWNER_ACTIVITY_UPDATES_MAX,
  OWNER_ACTIVITY_REQUEST_RAW_BUDGET_CHARS,
  OWNER_ACTIVITY_WINDOW_CHARS,
  OWNER_ACTIVITY_WINDOW_MARGIN_CHARS,
  OWNER_OLDER_REASONS,
  OWNER_SEQ_MAX,
  createFullTextCache,
} = Activity;
import { OWNER_PATH_MAX_CHARS, OWNER_PATH_WITHHELD } from "../../src/application/ownerWorkerDetail.js";
import { RUNTIME_ACTIVITY_STATUSES } from "../../src/runEvent.js";

// ===== 常量与夹具 =====

const T0 = Date.parse("2026-11-24T10:00:00.000Z");
const NOW = Date.parse("2026-11-24T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const jsonl = (events) => `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;

/** 假令牌带 placeholder 字样（脱敏守卫认可的夹具写法）；形状规则能识别它。 */
const SHAPE_SECRET = "sk-placeholder0123456789";
/** 环境里的"确切"秘密值：服务端 env 注入，名字命中密钥名规则。 */
const EXACT_SECRET = "test-secret-exact-value-7788";
/** 带引号与反斜杠的"确切"秘密：JSON 序列化会把它转义，序列化之后精确匹配就认不出了。 */
const QUOTED_SECRET = 'ab"cd\\ef-secret-77';
const SERVER_ENV = { OWNER_TEST_API_KEY: EXACT_SECRET, OWNER_TEST_QUOTED_SECRET: QUOTED_SECRET };
/** 仓库与运行目录之外的路径（正文、命令里会出现）。 */
const OUTSIDE_WIN = "D:\\outside\\docs\\spec.md";
const OUTSIDE_POSIX = "/opt/outside/tools/run.sh";
/** 物理越界的隔离违规字段（形状取自 ownerWorkerDetail.test.js 的 run_iso_physical）。 */
const ISO_GOOD = {
  reason: "file_written_physical_outside", destination: "main_checkout",
  reportedPath: "..\\escape\\a.txt", resolvedPath: "D:\\outside\\main\\a.txt", escapedAt: "D:\\outside\\link",
};

const ALPHA = (key) => ({ slug: "alpha-11111111", name: "alpha 项目", key });
const projectFact = (p) => ({ kind: "project", rulesVersion: "td190-r3", key: p.key, bucket: p.slug });

function makeStore(base) {
  const runDir = join(base, "runs");
  const alpha = ALPHA(join(base, "alpha-repo"));
  const bucket = join(runDir, "projects", alpha.slug);
  mkdirSync(bucket, { recursive: true });
  writeFileSync(
    join(bucket, ".project.json"),
    JSON.stringify({ key: alpha.key, slug: alpha.slug, displayName: alpha.name, rulesVersion: "td190-r3", createdAt: iso(T0), aliases: [] }),
    "utf8",
  );
  return {
    base, runDir, alpha, bucket,
    write: (runId, events) => writeFileSync(join(bucket, `${runId}.jsonl`), typeof events === "string" ? events : jsonl(events), "utf8"),
  };
}

/** 事件构造器：信封字段权威；每条事件自动走 1 秒；skip(n) 留下 n 个没有事件的 seq（真缺口）。 */
function builder(runId, { agentId = "glm-pro", noSeq = false } = {}) {
  const events = [];
  let seq = 0;
  let clock = T0;
  const b = {
    events,
    runId,
    skip(n) { seq += n; return b; },
    /** over.seq 可覆盖事件号（undefined = 去掉这个键，模拟没有事件号的旧档）。 */
    add(type, payload = {}, over = {}) {
      seq += 1;
      const event = { ...payload, seq, ts: iso(clock), type, runId, agentId, ...over };
      if (noSeq || event.seq === undefined) delete event.seq;
      clock += 1000;
      events.push(event);
      return b;
    },
    last: () => events[events.length - 1].seq,
  };
  return b;
}

const wtOf = (ctx, runId) => `${ctx.alpha.key}\\.wao-worktrees\\${runId}`;

/** 派发头：background_submitted → pending → run.started → prompt.sent（seq 1–4）。 */
function head(b, ctx, { worktree = true, duplicateStarted = false } = {}) {
  b.add("run.background_submitted", { background: true, cwd: ctx.alpha.key, deliveryRequested: false, project: projectFact(ctx.alpha) });
  b.add("run.state_change", { from: null, to: "pending", reason: "background_spawned" });
  b.add("run.started", {
    backend: "claude-code",
    cwd: ctx.alpha.key,
    ...(worktree ? { worktreePath: wtOf(ctx, b.runId), worktreeBranch: `wao/${b.runId}` } : {}),
    model: { id: "glm-5.3" },
    laneId: "glm-pro",
    roleId: "coder",
    resolvedFrom: "explicit",
  });
  b.add("prompt.sent", { prompt: "# 标准运行\n正文" });
  if (duplicateStarted) b.add("run.started", { backend: "claude-code", cwd: ctx.alpha.key, worktreePath: wtOf(ctx, b.runId) });
}

/** 开工：session.created（backend 给退出码推断用）→ submitted → running（seq +4）。 */
function working(b) {
  b.add("session.created", { backend: "claude-code", backendSessionId: "proc_4242", serveUrl: null });
  b.add("run.submitted", {});
  b.add("run.state_change", { from: "pending", to: "submitted", reason: "spawned" });
  b.add("run.state_change", { from: "submitted", to: "running", reason: "first_event" });
}

const say = (b, text, over = {}) => b.add("run.event", { kind: "message", role: "assistant", parts: [{ type: "text", text }] }, over);
/** 没有事件号的消息，且不占用号码（后面的有号事件接着前一个有号事件往下数）。 */
const sayUnnumbered = (b, text) => { say(b, text, { seq: undefined }); b.skip(-1); };
const command = (b, text, toolCallId, extra = {}) => b.add("run.event", { kind: "command", command: text, toolCallId, ...extra });
const output = (b, tool, out, isError = false) => b.add("run.event", { kind: "tool_result", tool, output: out, isError });
const written = (b, path) => b.add("run.event", { kind: "file_written", path });
const runtime = (b, status, over = {}) => b.add("run.event", { kind: "runtime_activity", status }, over);
const thinking = (b) => b.add("run.event", { kind: "thinking" });
const lines = (n, prefix = "line") => `${Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n")}\n`;
const rangeOf = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

// ===== 假 req/res =====

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
  return { status: state.statusCode, headers: state.headers, body: bytes.toString("utf8") };
}
const jsonOf = (r) => JSON.parse(r.body);

// ===== 世界 =====

let W;
const S = {}; // 夹具里各条事件的 seq（run_shapes 等）

async function buildWorld() {
  const base = mkdtempSync(join(tmpdir(), "wao-owner-worker-activity-"));
  const store = makeStore(base);
  const ctx = { alpha: store.alpha };
  const world = { base, store, ctx };
  const s = store;

  // —— run_long：4 条头事件 + 450 条助手消息（seq 5–454），不带终态 ——
  {
    const b = builder("run_long");
    head(b, ctx);
    for (let i = 1; i <= 450; i += 1) say(b, `message ${i}`);
    s.write("run_long", b.events);
  }

  // —— run_shapes：各类事件各一份，终态 failed ——
  {
    const runId = "run_shapes";
    const wt = wtOf(ctx, runId);
    const b = builder(runId);
    const mark = (name) => { S[name] = b.last(); };
    head(b, ctx);
    working(b); // seq 5–8
    say(b, lines(10, "m")); mark("msgMulti");
    command(b, "npm test -- orders", "tc1", { exitCode: 1 }); mark("cmdWire");
    output(b, "tc1", lines(100), true); mark("outLong");
    command(b, "git status", "tc2"); mark("cmdInferred");
    output(b, "tc2", "On branch main\n"); mark("outShort");
    command(b, "sleep 100", "tc3"); mark("cmdNone");
    b.add("run.event", { kind: "tool_use", tool: "Read", input: { file_path: `${wt}\\src\\a.js` } }); mark("toolUse");
    output(b, "tc4", lines(30, "t")); mark("outMid");
    output(b, "tc5", "a\r\nb\r\n"); mark("outCrlf");
    written(b, `${wt}\\src\\a.js`); mark("writeIn");
    written(b, `${wt.toLowerCase()}\\lower.txt`); mark("writeCase");
    written(b, "D:\\elsewhere\\x.txt"); mark("writeOut");
    written(b, `${wt}-evil\\x.txt`); mark("writeSibling");
    written(b, "..\\..\\x.txt"); mark("writeTraversal");
    written(b, "src\\c.js"); mark("writeRel");
    runtime(b, "initialized"); mark("rt1");
    runtime(b, "streaming");
    thinking(b); // 时间线之外：不打断折叠
    runtime(b, "process_active");
    runtime(b, "streaming");
    runtime(b, "process_active"); mark("rt5");
    say(b, "mid"); mark("msgMid");
    runtime(b, "files_changed"); mark("rtSingle");
    b.add("run.error", { phase: "wait", error: "boom" }); mark("err");
    b.add("run.state_change", { from: "running", to: "failed", reason: "backend_error" }); mark("stateFail");
    s.write(runId, b.events);
  }

  // —— run_gap：真缺口、折叠被缺口打断、筛选 ——
  {
    const b = builder("run_gap");
    const mark = (name) => { S[name] = b.last(); };
    head(b, ctx);
    say(b, "g5"); mark("g5");
    command(b, "echo 6", "g6"); mark("g6");
    say(b, "g7"); mark("g7");
    b.skip(7); // 8–14 没有事件
    say(b, "g15"); mark("g15");
    command(b, "echo 16", "g16"); mark("g16");
    runtime(b, "streaming"); mark("g17");
    runtime(b, "process_active"); mark("g18");
    b.skip(2); // 19–20 没有事件
    runtime(b, "streaming"); mark("g21");
    say(b, "g22"); mark("g22");
    s.write("run_gap", b.events);
  }

  // —— run_filter：消息、命令（含命令输出）、工具、错误 ——
  {
    const b = builder("run_filter");
    const mark = (name) => { S[name] = b.last(); };
    head(b, ctx);
    say(b, "f5"); mark("f5");
    command(b, "echo 6", "f6"); mark("f6");
    output(b, "f6", "6\n"); mark("f7");
    say(b, "f8"); mark("f8");
    command(b, "echo 9", "f9"); mark("f9");
    output(b, "f9", "boom\n", true); mark("f10");
    b.add("run.event", { kind: "tool_use", tool: "Grep", input: { pattern: "x" } }); mark("f11");
    output(b, "t9", "tool failed\n", true); mark("f12");
    b.add("run.error", { phase: "wait", error: "oops" }); mark("f13");
    runtime(b, "streaming"); mark("f14");
    say(b, "f15"); mark("f15");
    s.write("run_filter", b.events);
  }

  // —— 旧档：事件号缺失 / 重复 / 倒退 ——
  {
    const b = builder("run_legacy");
    const mark = (name) => { S[name] = b.last(); };
    head(b, ctx);
    say(b, "A"); // seq 5
    say(b, "B", { seq: undefined }); // 没有事件号
    say(b, "C", { seq: 6 });
    say(b, "D", { seq: 6 }); // 与 C 重复
    say(b, "E", { seq: 3 }); // 倒退，也与 run.started 重复
    say(b, "F", { seq: 8 }); // 5 与 8 之间 6 在（冲突）、7 真缺
    mark("last");
    s.write("run_legacy", b.events);
  }
  {
    const b = builder("run_noseq", { noSeq: true });
    head(b, ctx);
    for (const t of ["n1", "n2", "n3"]) say(b, t);
    s.write("run_noseq", b.events);
  }

  // —— 工作树权威：没有 / 不唯一 ——
  {
    const b = builder("run_nowt");
    head(b, ctx, { worktree: false });
    written(b, `${wtOf(ctx, "run_nowt")}\\src\\a.js`);
    written(b, "src\\b.js");
    s.write("run_nowt", b.events);
  }
  {
    const b = builder("run_dupstart");
    head(b, ctx, { duplicateStarted: true });
    written(b, `${wtOf(ctx, "run_dupstart")}\\src\\a.js`);
    s.write("run_dupstart", b.events);
  }

  // —— 隔离违规 ——
  {
    const b = builder("run_iso");
    const mark = (name) => { S[name] = b.last(); };
    head(b, ctx);
    working(b);
    b.add("run.isolation_violation", { code: "workdir_escape", ...ISO_GOOD }); mark("isoGood");
    b.add("run.isolation_violation", { code: "workdir_escape", reason: "nope", destination: "../../etc/passwd", reportedPath: 12345 }); mark("isoJunk");
    b.add("run.isolation_violation", { code: "something_else", reason: "file_written_lexical_outside", destination: "home" }); mark("isoOtherCode");
    s.write("run_iso", b.events);
  }

  // —— 全文分页 ——
  {
    const b = builder("run_page");
    const mark = (name) => { S[name] = b.last(); };
    head(b, ctx);
    output(b, "p1", `${"0123456789".repeat(7000)}\n`); mark("pageBig"); // 70 001 字节
    output(b, "p2", "中".repeat(20000)); mark("pageCjk"); // 60 000 字节，3 字节一个字
    command(b, lines(50, "cmdline"), "p3"); mark("pageCmd");
    b.add("run.error", { phase: "wait", error: "e".repeat(10_000) }); mark("pageErr");
    say(b, lines(40, "para")); mark("pageMsg");
    output(b, "p4", ""); mark("pageEmpty");
    output(b, "p5", `${"x".repeat(OWNER_EVENT_PAGE_MAX_BYTES - 10)}${EXACT_SECRET}-tail\n`); mark("pageStraddleExact");
    // 形状秘密要有词边界才认得出来：前面隔一个空格，起点仍落在第 32 768 字节之前 12 字节处。
    output(b, "p6", `${"y".repeat(OWNER_EVENT_PAGE_MAX_BYTES - 13)} ${SHAPE_SECRET}-tail\n`); mark("pageStraddleShape");
    s.write("run_page", b.events);
  }

  // —— 秘密、路径、控制字符 ——
  {
    const runId = "run_secret";
    const wt = wtOf(ctx, runId);
    const b = builder(runId);
    const mark = (name) => { S[name] = b.last(); };
    head(b, ctx);
    working(b);
    say(b, [
      `head ${EXACT_SECRET}`, `shape ${SHAPE_SECRET}`, `path ${OUTSIDE_WIN} and ${OUTSIDE_POSIX}`, `wt ${wt}\\src\\x.js`,
      "l5", "l6", "l7", `beyond ${EXACT_SECRET}`,
    ].join("\n")); mark("secMsg");
    command(b, `deploy --token=${EXACT_SECRET} --cwd ${wt} ${SHAPE_SECRET}`, "s1"); mark("secCmd");
    const out = Array.from({ length: 100 }, (_, i) => `out ${i + 1}`);
    out[1] = `secret-head ${EXACT_SECRET}`;
    out[49] = `secret-mid ${EXACT_SECRET} ${SHAPE_SECRET}`;
    out[98] = `secret-tail ${SHAPE_SECRET} at ${OUTSIDE_WIN}`;
    output(b, "s1", `${out.join("\n")}\n`); mark("secOut");
    b.add("run.event", { kind: "tool_use", tool: "Bash", input: { command: `curl -H "x: ${EXACT_SECRET}" ${SHAPE_SECRET}` } }); mark("secTool");
    written(b, `${wt}\\src\\${SHAPE_SECRET}.txt`); mark("secWrite");
    b.add("run.error", { phase: "wait", error: `failed with ${EXACT_SECRET} ${SHAPE_SECRET} in ${wt}\\x\nsecond line` }); mark("secErr");
    say(b, "\u001b[31mred\u001b[0m\u0007 bell\u0085 nel\u009b csi\u007f del"); mark("secCtl");
    s.write(runId, b.events);
  }

  // —— 结构化错误详情（run.error.detail 是对象）里藏着含引号与反斜杠的秘密 ——
  {
    const b = builder("run_errdetail");
    head(b, ctx);
    working(b);
    b.add("run.error", {
      phase: "wait",
      detail: {
        cmd: `run ${QUOTED_SECRET} now`,
        nested: { list: [`x${QUOTED_SECRET}y`, { deep: QUOTED_SECRET }] },
        [QUOTED_SECRET]: "keyed",
        note: `plain ${EXACT_SECRET}`,
      },
    });
    S.errDetail = b.last();
    s.write("run_errdetail", b.events);
  }

  // —— 有事件号与没有事件号的事件混在一起（头 4 条有号） ——
  for (const [runId, order] of [["run_mixed_a", ["m", "u"]], ["run_mixed_b", ["u", "m"]]]) {
    const b = builder(runId);
    head(b, ctx);
    for (const kind of order) {
      for (let i = 1; i <= 300; i += 1) {
        if (kind === "m") say(b, `m${i}`);
        else sayUnnumbered(b, `u${i}`);
      }
    }
    s.write(runId, b.events);
  }
  {
    const b = builder("run_unnumbered", { noSeq: true });
    head(b, ctx);
    for (let i = 1; i <= 300; i += 1) say(b, `u${i}`);
    s.write("run_unnumbered", b.events);
  }
  {
    const b = builder("run_unnumbered_big", { noSeq: true });
    head(b, ctx);
    for (let i = 1; i <= 1200; i += 1) say(b, `u${i}`);
    s.write("run_unnumbered_big", b.events);
  }
  {
    // 头 4 条有号，其后 1200 条没有：窗口之前最近的有号事件（头里的 seq 4）比一页的上限还远。
    const b = builder("run_capped");
    head(b, ctx);
    for (let i = 1; i <= 1200; i += 1) sayUnnumbered(b, `u${i}`);
    s.write("run_capped", b.events);
  }

  // —— 摘要与路径的诚实性（截断要标出、判不清的路径不给） ——
  {
    const runId = "run_honest";
    const wt = wtOf(ctx, runId);
    const b = builder(runId);
    const mark = (name) => { S[name] = b.last(); };
    head(b, ctx);
    b.add("run.event", { kind: "tool_use", tool: "Bash", input: { command: `echo ${"x".repeat(600)}` } }); mark("toolLong");
    b.add("run.event", { kind: "tool_use", tool: "Bash", input: { command: "echo hi" } }); mark("toolShort");
    b.add("run.event", { kind: "tool_use", tool: "T".repeat(100), input: {} }); mark("toolLongName");
    written(b, `${wt}\\src\\${"a".repeat(252)}`); mark("pathMax"); // 相对路径恰 256 字
    written(b, `${wt}\\src\\${"a".repeat(253)}`); mark("pathOver"); // 257 字
    written(b, `src\\${"b".repeat(300)}`); mark("pathOverRel");
    written(b, "C:outside/../src/a.txt"); mark("driveRel1");
    written(b, "C:foo"); mark("driveRel2");
    written(b, "c:"); mark("driveRel3");
    written(b, "C:/abs-elsewhere/x.txt"); mark("driveAbsOutside");
    written(b, `${wt}\\src\\ok.txt`); mark("pathOk");
    s.write(runId, b.events);
  }

  // —— 转录会被改写的运行（全文缓存按转录身份失效） ——
  {
    const b = builder("run_mutable");
    head(b, ctx);
    output(b, "mut", "version one\n");
    S.mutable = b.last();
    s.write("run_mutable", b.events);
  }

  let clock = NOW;
  const server = createOwnerDashboardServer({
    runDir: s.runDir,
    env: SERVER_ENV,
    nowFn: () => clock,
  });
  world.server = server;
  world.auth = { authorization: `Bearer ${server.token}` };
  world.get = (url, headers = world.auth) => drive(server.handler, { url, headers });
  world.activity = async (runId, query = "") => {
    const r = await world.get(`/api/worker/activity?runId=${runId}${query === "" ? "" : `&${query}`}`);
    assert.equal(r.status, 200, `${runId} ${query}: ${r.body.slice(0, 200)}`);
    return jsonOf(r);
  };
  world.eventUrl = (runId, seq, part, page) => `/api/worker/event?runId=${runId}&seq=${seq}&part=${part}${page === undefined ? "" : `&page=${page}`}`;
  world.event = async (runId, seq, part, page) => {
    const r = await world.get(world.eventUrl(runId, seq, part, page));
    assert.equal(r.status, 200, `${runId}#${seq} ${part} ${page}: ${r.body.slice(0, 200)}`);
    return jsonOf(r);
  };
  assert.equal(await server.refreshNow(), "ready");
  return world;
}

before(async () => { W = await buildWorld(); });
after(async () => {
  await W.server.close();
  rmrfRetry(W.base);
});

// ===== 小工具 =====

const eventRows = (page) => page.rows.filter((r) => r.row === "event");
const seqsOf = (page) => eventRows(page).map((r) => r.seq);
const rowAt = (page, seq) => {
  const found = page.rows.find((r) => r.row === "event" && r.seq === seq);
  assert.ok(found, `第 ${seq} 条应在这一页`);
  return found;
};
const gapsOf = (page) => page.rows.filter((r) => r.row === "gap");
const foldsOf = (page) => page.rows.filter((r) => r.row === "fold");

/** 一个秘密值可能以的几种形状：原文、JSON 转义一次（序列化进错误详情）、转义两次（再放进响应体）。 */
const secretForms = (secret) => {
  const once = JSON.stringify(secret).slice(1, -1);
  return [secret, once, JSON.stringify(once).slice(1, -1)];
};

/** 响应里不得出现的服务端私有串：临时根（含运行目录、仓库、工作树）与它在 JSON 里的转义写法。 */
function assertSafeText(body, { allowOutsidePaths = false } = {}) {
  const both = (needle) => [needle, JSON.stringify(needle).slice(1, -1)]; // 原文与它在 JSON 里的转义写法
  for (const needle of [W.base, W.store.runDir, W.store.alpha.key].flatMap(both)) {
    assert.ok(!body.includes(needle), `响应泄漏了 ${needle}`);
  }
  for (const secret of [SHAPE_SECRET, EXACT_SECRET]) assert.ok(!body.includes(secret), `响应带着未脱敏的秘密 ${secret}`);
  for (const form of secretForms(QUOTED_SECRET)) assert.ok(!body.includes(form), `响应带着带引号的秘密 ${form}`);
  assert.ok(!body.includes("ef-secret-77"), "带引号的秘密的任何一段都不留");
  assert.ok(!body.includes(W.server.token), "响应里没有令牌");
  assert.ok(!/worktreePath|\.wao-worktrees/.test(body), "响应里没有工作树字段或路径");
  if (!allowOutsidePaths) {
    for (const needle of [OUTSIDE_WIN, "D:\\outside", OUTSIDE_POSIX, "/opt/outside"].flatMap(both)) {
      assert.ok(!body.includes(needle), `响应泄漏了外部路径 ${needle}`);
    }
  }
}

/** 响应里每个字符串都没有控制字符（只许换行与制表符）。 */
function assertNoControlChars(value, where = "$") {
  if (typeof value === "string") {
    assert.ok(!/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(value), `${where} 带控制字符：${JSON.stringify(value.slice(0, 60))}`); // eslint-disable-line no-control-regex
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoControlChars(v, `${where}[${i}]`));
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) assertNoControlChars(v, `${where}.${k}`);
  }
}

// ===== 1. 窗口与翻页 =====

test("超过 200 条：不带 beforeSeq 只返回最近 200 条；beforeSeq 向上翻页，页与页之间不重不漏", async () => {
  assert.equal(OWNER_ACTIVITY_LIMIT_DEFAULT, 200);
  assert.equal(OWNER_ACTIVITY_LIMIT_MAX, 200);
  const first = await W.activity("run_long");
  assert.equal(first.runId, "run_long");
  assert.equal(first.total, 454, "事件总数 = 转录里全部事件（头 4 条 + 450 条消息）");
  assert.equal(first.limit, 200);
  assert.equal(first.filter, "all");
  assert.deepEqual(seqsOf(first), rangeOf(255, 454), "最近 200 条，按时间正序");
  assert.deepEqual(first.range, { fromSeq: 255, toSeq: 454 });
  assert.deepEqual(first.older, { available: true, beforeSeq: 255, reason: null });
  assert.deepEqual(first.hidden, { filtered: 0, folded: 0, unlisted: 0 });
  assert.equal(first.terminal, false, "这条运行还没到终态");
  assert.equal(first.state, "pending");

  const second = await W.activity("run_long", `beforeSeq=${first.older.beforeSeq}`);
  assert.deepEqual(seqsOf(second), rangeOf(55, 254));
  assert.deepEqual(second.older, { available: true, beforeSeq: 55, reason: null });

  const third = await W.activity("run_long", `beforeSeq=${second.older.beforeSeq}`);
  // 头事件里只有 pending 状态变化（seq 2）是时间线事件；seq 1、3、4 是控制面记账，不在时间线上。
  assert.deepEqual(seqsOf(third), [2, ...rangeOf(5, 54)]);
  assert.deepEqual(third.older, { available: false, beforeSeq: null, reason: null });
  assert.deepEqual(third.range, { fromSeq: 1, toSeq: 54 });
  assert.deepEqual(third.hidden, { filtered: 0, folded: 0, unlisted: 3 });

  const all = [...seqsOf(third), ...seqsOf(second), ...seqsOf(first)];
  assert.deepEqual(all, [2, ...rangeOf(5, 454)], "三页拼起来：每条恰好一次、没有缺漏、没有重复");
  assert.equal(gapsOf(first).length + gapsOf(second).length + gapsOf(third).length, 0, "页与页的交界不会凭空造出缺口");
});

test("limit：缺省 200、可调小、超过上限或形状不对由路由拒绝；beforeSeq 落在边上", async () => {
  const small = await W.activity("run_long", "limit=10");
  assert.deepEqual(seqsOf(small), rangeOf(445, 454));
  assert.deepEqual(small.older, { available: true, beforeSeq: 445, reason: null });
  const exact = await W.activity("run_long", "limit=200");
  assert.equal(exact.rows.length, 200);
  // beforeSeq 在第一条之前：什么都没有，也没有更早的。
  for (const before of [0, 1]) {
    const none = await W.activity("run_long", `beforeSeq=${before}`);
    assert.deepEqual(none.rows, []);
    assert.deepEqual(none.range, { fromSeq: null, toSeq: null });
    assert.deepEqual(none.older, { available: false, beforeSeq: null, reason: null });
  }
  // beforeSeq 超过最新一条：等同于不带。
  const beyond = await W.activity("run_long", "beforeSeq=999999");
  assert.deepEqual(seqsOf(beyond), rangeOf(255, 454));
  // 按 limit=50 一路翻到头：每条恰好一次。
  const seen = [];
  let query = "limit=50";
  for (let guard = 0; guard < 20; guard += 1) {
    const page = await W.activity("run_long", query);
    seen.unshift(...seqsOf(page));
    if (!page.older.available) break;
    query = `limit=50&beforeSeq=${page.older.beforeSeq}`;
  }
  assert.deepEqual(seen, [2, ...rangeOf(5, 454)]);
});

test("afterSeq：单独使用时取游标之后最新的一页；与 beforeSeq 同用时取这段区间最新的一页，页区间互不重叠，older 不越过下界", async () => {
  const latest = await W.activity("run_long", "afterSeq=254");
  assert.deepEqual(seqsOf(latest), rangeOf(255, 454));
  assert.deepEqual(latest.range, { fromSeq: 255, toSeq: 454 });
  assert.deepEqual(latest.older, { available: false, beforeSeq: null, reason: null }, "到了下界，不能再往前");

  const first = await W.activity("run_long", "afterSeq=440&limit=10");
  assert.deepEqual(seqsOf(first), rangeOf(445, 454));
  assert.deepEqual(first.range, { fromSeq: 445, toSeq: 454 });
  assert.deepEqual(first.older, { available: true, beforeSeq: 445, reason: null });
  const top = await W.activity("run_long", "afterSeq=440&limit=10&beforeSeq=445");
  assert.deepEqual(seqsOf(top), rangeOf(441, 444));
  assert.deepEqual(top.range, { fromSeq: 441, toSeq: 444 }, "下界从头覆盖，即使第一条事件是 #441 也标出这段区间");
  assert.deepEqual(top.older, { available: false, beforeSeq: null, reason: null });

  // 一路往上翻，每一页都在下界之上，拼起来正好是 (100, 150)。
  const seen = [];
  let query = "afterSeq=100&beforeSeq=150&limit=10";
  for (let guard = 0; guard < 20; guard += 1) {
    const page = await W.activity("run_long", query);
    assert.ok(seqsOf(page).every((seq) => seq > 100 && seq < 150), `页里出现了下界之外的事件：${seqsOf(page)}`);
    seen.unshift(...seqsOf(page));
    if (!page.older.available) break;
    assert.ok(page.older.beforeSeq > 100, "older.beforeSeq 不越过下界");
    query = `afterSeq=100&beforeSeq=${page.older.beforeSeq}&limit=10`;
  }
  assert.deepEqual(seen, rangeOf(101, 149));

  const empty = await W.activity("run_long", "afterSeq=454");
  assert.deepEqual(empty.rows, [], "游标之后没有事件：空页");
  assert.deepEqual(empty.older, { available: false, beforeSeq: null, reason: null });
});

test("afterSeq 和 beforeSeq 一样是 0..OWNER_SEQ_MAX 的整数：越界、负数、小数、非数字都被拒绝", async () => {
  for (const seq of [0, 1, OWNER_SEQ_MAX]) {
    const r = await W.get(`/api/worker/activity?runId=run_long&afterSeq=${seq}`);
    assert.equal(r.status, 200, `afterSeq=${seq}`);
  }
  for (const seq of ["-1", "1.5", "abc", "01", String(OWNER_SEQ_MAX + 1), "99999999999999999999"]) {
    const r = await W.get(`/api/worker/activity?runId=run_long&afterSeq=${encodeURIComponent(seq)}`);
    assert.equal(r.status, 400, `afterSeq=${seq}: ${r.body.slice(0, 120)}`);
  }
  // 两个下界/上界可以同用；形状错的那一个单独拒绝。
  assert.equal((await W.get("/api/worker/activity?runId=run_long&afterSeq=100&beforeSeq=200")).status, 200);
  assert.equal((await W.get("/api/worker/activity?runId=run_long&afterSeq=bad&beforeSeq=200")).status, 400);
  assert.equal((await W.get("/api/worker/activity?runId=run_long&afterSeq=100&beforeSeq=bad")).status, 400);
  for (const bad of [-1, 1.5, "5", null, OWNER_SEQ_MAX + 1]) {
    assert.throws(() => projectWorkerActivity({ runId: "run_long", events: [], afterSeq: bad, env: {} }), RangeError, `afterSeq=${String(bad)}`);
  }
});

test("updates 只带真正变了的命令行：已有退出码的 5 条命令配 5 条结果不产生更新；无退出码的第一条结果才产生一条", () => {
  assert.ok(OWNER_ACTIVITY_UPDATES_MAX <= OWNER_ACTIVITY_LIMIT_MAX);
  const withWire = builder("run_upd_wire");
  withWire.add("session.created", { backend: "claude-code" });
  for (let i = 1; i <= 5; i += 1) command(withWire, `cmd${i}`, `wire${i}`, { exitCode: 0 });
  for (let i = 1; i <= 5; i += 1) output(withWire, `wire${i}`, "ok", false);
  const wirePage = projectWorkerActivity({ runId: "run_upd_wire", events: withWire.events, afterSeq: withWire.events[5].seq, limit: 200, filter: "commands", env: {} });
  assert.deepEqual(wirePage.updates, [], "命令本来就有退出码，不能重发");

  const inferred = builder("run_upd_infer");
  inferred.add("session.created", { backend: "claude-code" });
  command(inferred, "needs-exit", "infer1");
  const commandSeq = inferred.last();
  output(inferred, "infer1", "1 failing", true);
  const page = projectWorkerActivity({ runId: "run_upd_infer", events: inferred.events, afterSeq: commandSeq, limit: 2, filter: "commands", env: {} });
  assert.equal(page.rows.length, 1);
  assert.equal(page.updates.length, 1);
  assert.deepEqual([page.updates[0].seq, page.updates[0].exitCode, page.updates[0].exitSource], [commandSeq, 1, "inferred"]);
  assert.ok(page.rows.length + page.updates.length <= 2, "rows 与 updates 共用这一页的预算");
});

test("sol 第 5 条：200 条已自带退出码的命令 + 200 条结果，afterSeq 最后一条命令、Commands 下 updates 为 0", () => {
  const b = builder("run_upd_200");
  b.add("session.created", { backend: "claude-code" });
  for (let i = 1; i <= 200; i += 1) command(b, `cmd${i}`, `many${i}`, { exitCode: 0 });
  const lastSeq = b.last();
  for (let i = 1; i <= 200; i += 1) output(b, `many${i}`, "ok", false);
  const page = projectWorkerActivity({ runId: "run_upd_200", events: b.events, afterSeq: lastSeq, limit: 200, filter: "commands", env: {} });
  assert.equal(page.rows.length, 200);
  assert.deepEqual(page.updates, [], "退出码早已存在，不能把 200 条命令全部重发");
  assert.ok(page.rows.length + page.updates.length <= 200);
});


test("updates 受本页预算约束：5 条待补退出码的命令 + 5 条结果、limit=3 时一页总数仍是 3", () => {
  const b = builder("run_upd_cap");
  b.add("session.created", { backend: "claude-code" });
  for (let i = 1; i <= 5; i += 1) command(b, `cmd${i}`, `cap${i}`);
  const lastSeq = b.last();
  for (let i = 1; i <= 5; i += 1) output(b, `cap${i}`, "1 failing", true);
  const page = projectWorkerActivity({ runId: "run_upd_cap", events: b.events, afterSeq: lastSeq, limit: 3, filter: "commands", env: {} });
  assert.ok(page.rows.length <= 3);
  assert.ok(page.rows.length + page.updates.length <= 3, `rows ${page.rows.length} + updates ${page.updates.length}`);
});


test("afterSeq 页的 range 从区间起点算：下界之后先缺一段号时，fromSeq 是 afterSeq+1，页首补出真实缺口", () => {
  const events = messagesWithSeqs("run_gap3", [2, 5, 7]);
  const page = projectWorkerActivity({ runId: "run_gap3", events, afterSeq: 2, env: {} });
  assert.deepEqual(page.range, { fromSeq: 3, toSeq: 7 }, "不是从第一条实际事件 #5 算，否则 #3–#4 看起来像接上了下界");
  assert.deepEqual(gapsOf(page), [
    { row: "gap", fromSeq: 3, toSeq: 4, count: 2 },
    { row: "gap", fromSeq: 6, toSeq: 6, count: 1 },
  ], "页首的缺口和页内的真实缺口都如实给出");
  assert.deepEqual(seqsOf(page), [5, 7]);
});


test("gap 计入页预算：200 条事件 + 页首 gap 时第一页仍是 200 行；gap 留在上一页，range 包住本页每一行", () => {
  const events = messagesWithSeqs("run_gaphead", [1, ...rangeOf(4, 203)]);
  const first = projectWorkerActivity({ runId: "run_gaphead", events, afterSeq: 1, limit: 200, env: {} });
  assert.equal(first.rows.length, 200, "不是 200 条事件再加一条 gap");
  assert.deepEqual(first.range, { fromSeq: 4, toSeq: 203 }, "range 从本页第一行开始，不虚报 #2–#3");
  assert.deepEqual(first.older, { available: true, beforeSeq: 4, reason: null });
  const gap = projectWorkerActivity({ runId: "run_gaphead", events, afterSeq: 1, beforeSeq: 4, limit: 200, env: {} });
  assert.deepEqual(gap.rows, [{ row: "gap", fromSeq: 2, toSeq: 3, count: 2 }], "gap 单独一页，没有丢");
  assert.deepEqual(gap.range, { fromSeq: 2, toSeq: 3 });
  assert.deepEqual(gap.older, { available: false, beforeSeq: null, reason: null });
  for (const page of [first, gap]) assert.ok(page.rows.length <= 200);
});

test("双游标区间只剩缺口时返回 gap 页，不是空页", () => {
  const events = messagesWithSeqs("run_gaponly", [1, 4, 6]);
  const onlyGap = projectWorkerActivity({ runId: "run_gaponly", events, afterSeq: 1, beforeSeq: 4, env: {} });
  assert.deepEqual(onlyGap.rows, [{ row: "gap", fromSeq: 2, toSeq: 3, count: 2 }]);
  assert.deepEqual(onlyGap.range, { fromSeq: 2, toSeq: 3 });
  assert.deepEqual(onlyGap.older, { available: false, beforeSeq: null, reason: null });
});

test("页尾 gap 也进 range：afterSeq=1&beforeSeq=6 的 #5 缺口必须落在 range.toSeq 里", () => {
  const events = messagesWithSeqs("run_gaptail", [1, 4, 6]);
  const withTail = projectWorkerActivity({ runId: "run_gaptail", events, afterSeq: 1, beforeSeq: 6, env: {} });
  assert.deepEqual(
    withTail.rows.map((row) => (row.row === "gap" ? `gap${row.fromSeq}-${row.toSeq}` : `#${row.seq}`)),
    ["gap2-3", "#4", "gap5-5"],
  );
  assert.deepEqual(withTail.range, { fromSeq: 2, toSeq: 5 }, "range.toSeq 包住页尾 gap #5，不只是 #4");
  assert.deepEqual(withTail.older, { available: false, beforeSeq: null, reason: null });
});

test("页首 gap 也要占预算：limit=3 时 3 个事件单位已经占满，gap 留给上一页", () => {
  const events = messagesWithSeqs("run_gaptight", [1, 4, 6]);
  const tight = projectWorkerActivity({ runId: "run_gaptight", events, afterSeq: 1, limit: 3, env: {} });
  assert.deepEqual(tight.rows.map((row) => (row.row === "gap" ? `gap${row.fromSeq}-${row.toSeq}` : `#${row.seq}`)), ["#4", "gap5-5", "#6"]);
  assert.equal(tight.rows.length, 3);
  assert.deepEqual(tight.older, { available: true, beforeSeq: 4, reason: null });
});

test("冲突号已经作为行返回时，gap 不再覆盖它：转录顺序 #1、#8、#2 里，#2 是冲突行，缺口从 #3 开始", () => {
  const events = messagesWithSeqs("run_gapconflict", [1, 8, 2]);
  const page = projectWorkerActivity({ runId: "run_gapconflict", events, afterSeq: 1, env: {} });
  const conflict = page.rows.find((row) => row.row === "event" && row.seq === 2);
  assert.equal(conflict.seqState, "conflict");
  const gap = page.rows.find((row) => row.row === "gap");
  assert.deepEqual([gap.fromSeq, gap.toSeq], [3, 7], "缺口不包含已经显示的 #2");
  assert.deepEqual(page.range, { fromSeq: 2, toSeq: 8 }, "range 同时包住冲突行和缺口");
});


test("afterSeq 页的 updates 带出被后续 tool_result 补全的更早命令行：它不在 rows/range 里，只供客户端按 key 替换", async () => {
  const page = await W.activity("run_shapes", `afterSeq=${S.cmdInferred}`);
  assert.ok(seqsOf(page).includes(S.outShort), "结果之后的输出行仍在页里");
  assert.ok(!seqsOf(page).includes(S.cmdInferred), "命令行本身不在页的 rows 里");
  const update = page.updates.find((row) => row.row === "event" && row.seq === S.cmdInferred);
  assert.ok(update, "更新通道带出了更早的命令行");
  assert.deepEqual([update.exitCode, update.exitSource], [0, "inferred"], "用的是服务端投影的退出码，不是客户端猜的");
  assert.ok(page.range.fromSeq > S.cmdInferred, "更新不会把页的覆盖区间往左拉");
  const messages = await W.activity("run_shapes", `afterSeq=${S.cmdInferred}&filter=messages`);
  assert.deepEqual(messages.updates, [], "筛选把命令行隐藏时，更新通道也不会把它漏出来");
});



// ===== 2. 各类事件的内容 =====

test("类型码是闭集；行的形状：每条事件有 seq、seqState、ts、code、summary；终态与事件总数随响应给出", async () => {
  const page = await W.activity("run_shapes");
  assert.equal(page.terminal, true);
  assert.equal(page.state, "failed");
  assert.deepEqual(page.older, { available: false, beforeSeq: null, reason: null });
  for (const row of page.rows) {
    assert.ok(["event", "fold", "gap"].includes(row.row), row.row);
    if (row.row === "gap") continue;
    assert.ok(OWNER_ACTIVITY_CODES.includes(row.code), `类型码 ${row.code}`);
    if (row.row === "fold") continue;
    assert.ok(OWNER_SEQ_STATES.includes(row.seqState));
    assert.equal(typeof row.summary, "string");
    assert.equal(typeof row.truncated, "boolean");
    assert.ok(typeof row.ts === "string" && row.ts.startsWith("2026-11-24T"));
  }
  assert.deepEqual([...new Set(page.rows.filter((r) => r.row !== "gap").map((r) => r.code))].sort(), [...OWNER_ACTIVITY_CODES].sort(), "这份夹具里八种码各出现过");
  assert.deepEqual(seqsOf(page), [...seqsOf(page)].sort((a, b) => a - b), "按时间正序");
});

test("助手消息：前 6 行 + 总行数；摘要是第一行；超出部分可取全文", async () => {
  const page = await W.activity("run_shapes");
  const row = rowAt(page, S.msgMulti);
  assert.equal(row.code, "MSG");
  assert.equal(row.role, "assistant");
  assert.equal(OWNER_MESSAGE_HEAD_LINES, 6);
  assert.deepEqual(row.body, { head: ["m 1", "m 2", "m 3", "m 4", "m 5", "m 6"], tail: [], totalLines: 10, omittedLines: 4 });
  assert.equal(row.summary, "m 1");
  assert.equal(row.truncated, true);
  assert.equal(row.part, "message");
  const short = rowAt(page, S.msgMid);
  assert.deepEqual(short.body, { head: ["mid"], tail: [], totalLines: 1, omittedLines: 0 });
  assert.equal(short.truncated, false);
});

test("命令：一行命令，结果到了补退出码（线上给的 / 可信后端从结果推断的 / 还没有结果就是 null）", async () => {
  const page = await W.activity("run_shapes");
  const wire = rowAt(page, S.cmdWire);
  assert.equal(wire.code, "CMD");
  assert.equal(wire.summary, "npm test -- orders");
  assert.deepEqual([wire.exitCode, wire.exitSource], [1, "wire"]);
  const inferred = rowAt(page, S.cmdInferred);
  assert.deepEqual([inferred.exitCode, inferred.exitSource], [0, "inferred"], "claude-code 的 isError=false 推断为 0，且标明是推断");
  const pending = rowAt(page, S.cmdNone);
  assert.deepEqual([pending.exitCode, pending.exitSource], [null, null]);
  assert.equal(wire.truncated, false);
});

test("命令输出、工具结果：头 20 行 + 尾 20 行 + 总行数；不足 40 行不丢行；标明是命令输出还是工具结果", async () => {
  assert.equal(OWNER_OUTPUT_HEAD_LINES, 20);
  assert.equal(OWNER_OUTPUT_TAIL_LINES, 20);
  const page = await W.activity("run_shapes");
  const long = rowAt(page, S.outLong);
  assert.equal(long.code, "OUT");
  assert.equal(long.outputOf, "command");
  assert.equal(long.isError, true);
  assert.deepEqual(long.body.head, rangeOf(1, 20).map((n) => `line ${n}`));
  assert.deepEqual(long.body.tail, rangeOf(81, 100).map((n) => `line ${n}`));
  assert.equal(long.body.totalLines, 100, "总行数是全文的行数，不是头尾的行数");
  assert.equal(long.body.omittedLines, 60);
  assert.equal(long.summary, "line 1");
  assert.equal(long.truncated, true);
  assert.equal(long.part, "output");

  const mid = rowAt(page, S.outMid);
  assert.equal(mid.outputOf, "tool", "没有对应命令的结果是工具结果");
  assert.deepEqual(mid.body.head, rangeOf(1, 20).map((n) => `t ${n}`));
  assert.deepEqual(mid.body.tail, rangeOf(21, 30).map((n) => `t ${n}`), "21–40 行：头 20 行之后的行全进尾，不留空洞");
  assert.equal(mid.body.omittedLines, 0);
  assert.equal(mid.truncated, false);

  const short = rowAt(page, S.outShort);
  assert.deepEqual(short.body, { head: ["On branch main"], tail: [], totalLines: 1, omittedLines: 0 });
  assert.equal(short.isError, false);
  assert.equal(short.outputOf, "command");

  // Windows 的 CRLF：换行归一，不留替换符，总行数照实。
  const crlf = rowAt(page, S.outCrlf);
  assert.deepEqual(crlf.body, { head: ["a", "b"], tail: [], totalLines: 2, omittedLines: 0 });
});

test("工具调用：一行（工具名 + 输入里最能说明对象的字段，路径折成末段）", async () => {
  const page = await W.activity("run_shapes");
  const row = rowAt(page, S.toolUse);
  assert.equal(row.code, "TOOL");
  assert.equal(row.tool, "Read");
  assert.ok(row.summary.startsWith("Read ") && row.summary.endsWith("a.js") && !row.summary.includes(W.base), `摘要：${row.summary}`);
  assert.equal(row.part, null, "工具调用只有一行摘要，没有全文");
});

test("写文件：工作树内给相对路径（大小写不敏感、段边界），工作树外或判不清给 [path_withheld]；增删行未知", async () => {
  const page = await W.activity("run_shapes");
  const pathOf = (name) => rowAt(page, S[name]).path;
  assert.equal(pathOf("writeIn"), "src/a.js");
  assert.equal(pathOf("writeCase"), "lower.txt", "Windows 绝对路径按大小写折叠判包含");
  assert.equal(pathOf("writeRel"), "src/c.js");
  assert.equal(pathOf("writeOut"), OWNER_PATH_WITHHELD);
  assert.equal(pathOf("writeSibling"), OWNER_PATH_WITHHELD, "wt-evil 不是 wt 的子路径");
  assert.equal(pathOf("writeTraversal"), OWNER_PATH_WITHHELD);
  const row = rowAt(page, S.writeIn);
  assert.equal(row.code, "WRITE");
  assert.equal(row.summary, "src/a.js");
  assert.deepEqual([row.added, row.deleted], [null, null], "没有后端绑定的增删行观测：未知");
  assert.equal(row.part, null);

  // 没有工作树权威（没有 worktreePath / 有两条 run.started）：一律判不清，连相对路径也不给。
  for (const runId of ["run_nowt", "run_dupstart"]) {
    const paths = eventRows(await W.activity(runId)).filter((r) => r.code === "WRITE").map((r) => r.path);
    assert.ok(paths.length >= 1 && paths.every((p) => p === OWNER_PATH_WITHHELD), `${runId}: ${paths}`);
  }
});

test("状态变化与错误：状态变化单独一条（from / to / reason 取闭集）；错误给全文（有界）与阶段", async () => {
  const page = await W.activity("run_shapes");
  const state = rowAt(page, S.stateFail);
  assert.equal(state.code, "STATE");
  assert.deepEqual([state.from, state.to, state.reason, state.summary], ["running", "failed", "backend_error", "failed"]);
  const first = eventRows(page).find((r) => r.code === "STATE");
  assert.deepEqual([first.from, first.to, first.reason], [null, "pending", "background_spawned"]);
  const err = rowAt(page, S.err);
  assert.equal(err.code, "ERR");
  assert.equal(err.phase, "wait");
  assert.equal(err.text, "boom");
  assert.equal(err.totalChars, 4);
  assert.equal(err.summary, "boom");
  assert.equal(err.truncated, false);
  assert.equal(err.isolation, null);

  const long = rowAt(await W.activity("run_page"), S.pageErr);
  assert.equal(long.text.length, OWNER_ERROR_MAX_CHARS, "错误全文有界");
  assert.equal(long.totalChars, 10_000);
  assert.equal(long.truncated, true);
  assert.equal(long.part, "error");
});

test("隔离违规：照共用投影显示（与 isolationViolationDetail 同一份），闭集外与别的安全码不回显", async () => {
  const page = await W.activity("run_iso");
  const good = rowAt(page, S.isoGood);
  assert.equal(good.code, "ERR");
  assert.deepEqual(good.isolation, {
    reason: "file_written_physical_outside", destination: "main_checkout",
    reportedPath: "..\\escape\\a.txt", resolvedPath: "D:\\outside\\main\\a.txt", escapedAt: "D:\\outside\\link",
  });
  // 与共用投影逐字段一致：行里的 isolation 就是 isolationViolationDetail 对同一条事件的结果。
  const shared = isolationViolationDetail([{ type: "run.isolation_violation", runId: "run_iso", code: "workdir_escape", ...ISO_GOOD }], "run_iso", { env: SERVER_ENV });
  assert.deepEqual(good.isolation, { reason: shared.reason, destination: shared.destination, reportedPath: shared.reportedPath, resolvedPath: shared.resolvedPath, escapedAt: shared.escapedAt });
  assert.equal(good.summary, "isolation violation: file_written_physical_outside");
  assert.equal(rowAt(page, S.isoJunk).isolation, null, "没有一个可信字段 → null");
  assert.equal(rowAt(page, S.isoJunk).summary, "isolation violation");
  assert.equal(rowAt(page, S.isoOtherCode).isolation, null, "不是 workdir_escape 的安全码不算");
  assertNoControlChars(page);
});

// ===== 3. 折叠、缺口、筛选 =====

test("连续的运行时活动折叠成一行：原始 seq 区间、条数、最后一种运行时状态；时间线之外的事件不打断，别的事件打断", async () => {
  const page = await W.activity("run_shapes");
  const folds = foldsOf(page);
  assert.equal(folds.length, 2);
  const [five, single] = folds;
  assert.deepEqual(
    { code: five.code, fromSeq: five.fromSeq, toSeq: five.toSeq, count: five.count, status: five.status, seqState: five.seqState },
    { code: "RT", fromSeq: S.rt1, toSeq: S.rt5, count: 5, status: "process_active", seqState: "ok" },
    "5 条运行时活动（中间夹一条 thinking）折成一行，区间覆盖 thinking 的 seq",
  );
  assert.equal(S.rt5 - S.rt1, 5, "区间里确实夹着一个不在时间线上的事件");
  assert.ok(RUNTIME_ACTIVITY_STATUSES.includes(five.status));
  assert.ok(typeof five.fromTs === "string" && typeof five.toTs === "string");
  assert.deepEqual([single.fromSeq, single.toSeq, single.count, single.status], [S.rtSingle, S.rtSingle, 1, "files_changed"], "被 MSG 隔开的下一段单独成行");
  assert.equal(page.hidden.folded, 6, "被折叠的事件数 = 5 + 1");
  assert.equal(page.hidden.unlisted >= 1, true, "thinking 与控制面记账不在时间线上");
  // 折叠行在行序里的位置：夹在 rt1 前后的事件之间。
  const order = page.rows.map((r) => (r.row === "fold" ? `fold@${r.fromSeq}` : r.row === "event" ? r.seq : r.row));
  assert.ok(order.indexOf(`fold@${S.rt1}`) > order.indexOf(S.writeRel) && order.indexOf(`fold@${S.rt1}`) < order.indexOf(S.msgMid));
});

test("seq 缺口如实标出；缺口打断折叠；筛选掉的与时间线之外的条目不被当作缺失", async () => {
  const all = await W.activity("run_gap");
  assert.deepEqual(gapsOf(all), [
    { row: "gap", fromSeq: 8, toSeq: 14, count: 7 },
    { row: "gap", fromSeq: 19, toSeq: 20, count: 2 },
  ]);
  const shape = all.rows.map((r) => (r.row === "gap" ? `gap${r.fromSeq}-${r.toSeq}` : r.row === "fold" ? `fold${r.fromSeq}-${r.toSeq}` : `#${r.seq}`));
  assert.deepEqual(shape, [
    "#2", `#${S.g5}`, `#${S.g6}`, `#${S.g7}`, "gap8-14", `#${S.g15}`, `#${S.g16}`, `fold${S.g17}-${S.g18}`, "gap19-20", `fold${S.g21}-${S.g21}`, `#${S.g22}`,
  ]);
  assert.equal(all.hidden.filtered, 0);

  // 只看消息：命令、状态、运行时活动都被筛掉——它们不是缺失；真缺口照样在。
  const messages = await W.activity("run_gap", "filter=messages");
  assert.deepEqual(seqsOf(messages), [S.g5, S.g7, S.g15, S.g22]);
  assert.deepEqual(gapsOf(messages), gapsOf(all), "筛选不改变哪些 seq 真的缺失");
  assert.equal(messages.hidden.filtered, 6, "STATE + 两条命令 + 三条运行时活动");
  assert.equal(messages.hidden.unlisted, 3);
  assert.equal(foldsOf(messages).length, 0);
  assert.equal(messages.filter, "messages");
  assert.equal(messages.total, all.total, "事件总数不随筛选变化");
});

test("filter 闭集：messages / commands（含命令输出）/ errors（含出错的输出）；其余值由路由拒绝", async () => {
  assert.deepEqual([...OWNER_ACTIVITY_FILTERS], ["all", "messages", "commands", "errors"]);
  const seqsFor = async (filter) => seqsOf(await W.activity("run_filter", `filter=${filter}`));
  assert.deepEqual(await seqsFor("messages"), [S.f5, S.f8, S.f15]);
  assert.deepEqual(await seqsFor("commands"), [S.f6, S.f7, S.f9, S.f10], "命令与命令的输出；不含没有对应命令的工具结果");
  assert.deepEqual(await seqsFor("errors"), [S.f10, S.f12, S.f13], "出错的输出（命令的与工具的）与错误事件");
  const all = await W.activity("run_filter", "filter=all");
  assert.deepEqual(seqsOf(all), [2, S.f5, S.f6, S.f7, S.f8, S.f9, S.f10, S.f11, S.f12, S.f13, S.f15]);
  assert.equal(foldsOf(all).length, 1);
  const messages = await W.activity("run_filter", "filter=messages");
  assert.equal(messages.hidden.filtered, 9, "消息之外的 8 条事件 + 1 条状态变化");
  assert.equal(gapsOf(messages).length, 0, "筛掉的不是缺失：没有缺口记录");
  assert.equal((await W.activity("run_filter")).filter, "all", "缺省 all");
});

// ===== 4. seq 的真实性 =====

test("旧档：没有事件号 / 事件号重复 / 倒退都明确标出，缺口不把已存在的号当缺失", async () => {
  const page = await W.activity("run_legacy");
  const byText = (letter) => eventRows(page).find((r) => r.summary === letter);
  assert.deepEqual([byText("A").seq, byText("A").seqState], [5, "ok"]);
  assert.deepEqual([byText("B").seq, byText("B").seqState], [null, "missing"]);
  assert.deepEqual([byText("C").seq, byText("C").seqState], [6, "conflict"]);
  assert.deepEqual([byText("D").seq, byText("D").seqState], [6, "conflict"]);
  assert.deepEqual([byText("E").seq, byText("E").seqState], [3, "conflict"], "倒退的事件号标冲突");
  assert.deepEqual([byText("F").seq, byText("F").seqState], [8, "ok"]);
  for (const letter of ["B", "C", "D", "E"]) assert.equal(byText(letter).part, null, "没有唯一事件号的事件取不了全文");
  assert.equal(byText("A").part, "message");
  // 5 与 8 之间：6 被 C、D 占着（冲突，不是缺失），只有 7 真缺。
  assert.deepEqual(gapsOf(page), [{ row: "gap", fromSeq: 7, toSeq: 7, count: 1 }]);
  assert.deepEqual(page.range, { fromSeq: 1, toSeq: 8 }, "范围只按唯一事件号算");
  // 取全文：只有唯一的号能寻址。
  assert.equal((await W.get(W.eventUrl("run_legacy", 5, "message"))).status, 200);
  for (const seq of [6, 3]) assert.equal((await W.get(W.eventUrl("run_legacy", seq, "message"))).status, 404, `#${seq} 重复，寻址不唯一`);
  assert.equal((await W.get(W.eventUrl("run_legacy", 7, "message"))).status, 404, "缺失的号没有事件");
});

test("整份转录没有事件号：每行 seq 为 null 且标 missing，没有缺口；页一直取到最早，older 写明原因 unnumbered", async () => {
  const page = await W.activity("run_noseq");
  assert.ok(eventRows(page).every((r) => r.seq === null && r.seqState === "missing"));
  assert.equal(gapsOf(page).length, 0);
  assert.deepEqual(page.range, { fromSeq: null, toSeq: null });
  assert.deepEqual(eventRows(page).map((r) => r.summary), ["pending", "n1", "n2", "n3"]);
  // 窗口之前全是没有事件号的事件，没有 beforeSeq 可以翻——所以这一页取到最早（比 limit 多），不假装还能往上翻。
  const small = await W.activity("run_noseq", "limit=2");
  assert.deepEqual(eventRows(small).map((r) => r.summary), ["pending", "n1", "n2", "n3"]);
  assert.deepEqual(small.older, { available: false, beforeSeq: null, reason: "unnumbered" });
});

// ===== 5. 全文分页 =====

test("全文分页：页数与每页字节数、末页长度正确；越界被拒；每页 ≤ 字节上限", async () => {
  assert.ok(Number.isInteger(OWNER_EVENT_PAGE_MAX_BYTES) && OWNER_EVENT_PAGE_MAX_BYTES >= 1024);
  assert.deepEqual([...OWNER_EVENT_PARTS].sort(), ["command", "error", "message", "output"]);
  const total = 70_001;
  const pages = Math.ceil(total / OWNER_EVENT_PAGE_MAX_BYTES);
  assert.equal(pages, 3);
  const bytesOf = (text) => Buffer.byteLength(text, "utf8");
  const collected = [];
  for (let page = 1; page <= pages; page += 1) {
    const r = await W.event("run_page", S.pageBig, "output", page);
    assert.deepEqual([r.runId, r.seq, r.code, r.part, r.page, r.totalPages, r.totalBytes], ["run_page", S.pageBig, "OUT", "output", page, 3, total]);
    collected.push(r.text);
  }
  assert.deepEqual(collected.map(bytesOf), [OWNER_EVENT_PAGE_MAX_BYTES, OWNER_EVENT_PAGE_MAX_BYTES, total - 2 * OWNER_EVENT_PAGE_MAX_BYTES], "最后一页是余下的字节");
  assert.equal(collected.join(""), `${"0123456789".repeat(7000)}\n`, "拼起来就是全文");
  // 缺省页号是第 1 页。
  assert.equal((await W.event("run_page", S.pageBig, "output")).page, 1);
  // 越界：页号超过总页数 → 固定 404；0 与非规范写法 → 400。
  const beyond = await W.get(W.eventUrl("run_page", S.pageBig, "output", 4));
  assert.deepEqual([beyond.status, jsonOf(beyond)], [404, { error: "not_found" }]);
  for (const bad of ["0", "-1", "01", "1.5", "abc", "", "1e2", "+1", "9999999999"]) {
    const r = await W.get(W.eventUrl("run_page", S.pageBig, "output", encodeURIComponent(bad)));
    assert.deepEqual([r.status, jsonOf(r)], [400, { error: "bad_request" }], `page=${JSON.stringify(bad)}`);
  }
});

test("全文分页：多字节字符不被劈开；空文本是 1 页空串", async () => {
  const cjk = [];
  const first = await W.event("run_page", S.pageCjk, "output", 1);
  assert.equal(first.totalBytes, 60_000);
  assert.equal(first.totalPages, 2);
  cjk.push(first.text, (await W.event("run_page", S.pageCjk, "output", 2)).text);
  assert.deepEqual(cjk.map((t) => Buffer.byteLength(t, "utf8")), [32_766, 27_234], "每页取到不超上限的最后一个完整字符");
  assert.equal(cjk.join(""), "中".repeat(20_000));
  assert.ok(!cjk.join("").includes("�"));
  const empty = await W.event("run_page", S.pageEmpty, "output");
  assert.deepEqual([empty.text, empty.totalPages, empty.totalBytes], ["", 1, 0]);
});

test("全文分页：命令、消息、错误各取各的 part；part 不适用 / seq 不存在 / 号不唯一 → 固定 404", async () => {
  const cmd = await W.event("run_page", S.pageCmd, "command");
  assert.equal(cmd.code, "CMD");
  assert.equal(cmd.text, lines(50, "cmdline"));
  const msg = await W.event("run_page", S.pageMsg, "message");
  assert.equal(msg.text, lines(40, "para"));
  const err = await W.event("run_page", S.pageErr, "error");
  assert.deepEqual([err.code, err.totalBytes, err.text.length], ["ERR", 10_000, 10_000], "行里被截到 4000 字的错误，全文在这里取全");

  for (const [seq, part] of [[S.pageCmd, "output"], [S.pageBig, "command"], [S.pageMsg, "error"], [S.pageErr, "message"], [S.pageBig, "message"]]) {
    const r = await W.get(W.eventUrl("run_page", seq, part));
    assert.deepEqual([r.status, jsonOf(r)], [404, { error: "not_found" }], `#${seq} ${part}`);
  }
  // 没有全文的事件（写文件、状态变化、运行时活动、工具调用）、控制面记账（seq 1）、不存在的号：每个 part 都 404。
  for (const seq of [S.writeIn, S.stateFail, S.rt1, S.toolUse, 1, 99999]) {
    for (const part of OWNER_EVENT_PARTS) {
      assert.equal((await W.get(W.eventUrl("run_shapes", seq, part))).status, 404, `#${seq} ${part}`);
    }
  }
  assert.equal((await W.get(W.eventUrl("run_nobody", 1, "message"))).status, 404, "不存在的运行");
});

// ===== 6. 秘密、路径、控制字符 =====

test("秘密：摘要、头尾、折叠前的全文逐页、错误、写文件路径里的精确值与形状秘密都被替换；绝对路径折成末段", async () => {
  const page = await W.activity("run_secret");
  const body = JSON.stringify(page);
  assertSafeText(body);
  assert.ok(body.includes("[REDACTED"), "确实发生了替换");
  // 头 / 尾里的秘密都被换掉了，但行还在。
  const out = rowAt(page, S.secOut);
  assert.ok(out.body.head[1].startsWith("secret-head ") && !out.body.head[1].includes(EXACT_SECRET));
  assert.ok(out.body.tail.at(-2).startsWith("secret-tail ") && !out.body.tail.at(-2).includes(SHAPE_SECRET));
  assert.ok(out.body.tail.at(-2).includes("…/spec.md"), "外部绝对路径折成末段");
  const msg = rowAt(page, S.secMsg);
  assert.ok(msg.body.head.every((l) => !l.includes(EXACT_SECRET) && !l.includes(SHAPE_SECRET)));
  assert.ok(msg.body.head[2].includes("…/spec.md") && msg.body.head[2].includes("…/run.sh"));
  assert.ok(msg.body.head[3].endsWith("…/x.js"), `工作树内的绝对路径在正文里也折成末段：${msg.body.head[3]}`);
  const cmd = rowAt(page, S.secCmd);
  assert.ok(!cmd.summary.includes(EXACT_SECRET) && !cmd.summary.includes(SHAPE_SECRET) && cmd.summary.includes("--cwd …/run_secret"), cmd.summary);
  assert.ok(!rowAt(page, S.secTool).summary.includes(EXACT_SECRET));
  const write = rowAt(page, S.secWrite);
  assert.ok(!write.path.includes(SHAPE_SECRET) && write.path.startsWith("src/"), write.path);
  assert.ok(!rowAt(page, S.secErr).text.includes(EXACT_SECRET));

  // 全文：每个部分、每一页。
  for (const [seq, part] of [[S.secMsg, "message"], [S.secCmd, "command"], [S.secOut, "output"], [S.secErr, "error"]]) {
    const r = await W.get(W.eventUrl("run_secret", seq, part));
    assert.equal(r.status, 200, `#${seq} ${part}`);
    assertSafeText(r.body);
    assert.ok(!jsonOf(r).text.includes("D:\\"), "全文里也没有盘符路径");
  }
  const full = (await W.event("run_secret", S.secOut, "output")).text;
  assert.ok(full.includes("secret-mid ") && !full.includes(EXACT_SECRET) && !full.includes(SHAPE_SECRET), "中间那行只在全文里，也已脱敏");
  assert.ok((await W.event("run_secret", S.secMsg, "message")).text.split("\n").at(-1).startsWith("beyond "), "前 6 行之外的行在全文里");
});

test("秘密跨在页边界上：先脱敏再分页——任何一页都不留秘密的前半或后半", async () => {
  for (const [name, secret] of [["pageStraddleExact", EXACT_SECRET], ["pageStraddleShape", SHAPE_SECRET]]) {
    const first = await W.event("run_page", S[name], "output", 1);
    assert.ok(first.totalPages >= 1);
    const pages = [first.text];
    for (let page = 2; page <= first.totalPages; page += 1) pages.push((await W.event("run_page", S[name], "output", page)).text);
    for (const text of pages) {
      for (const fragment of [secret.slice(0, 10), secret.slice(secret.length - 10), secret]) {
        assert.ok(!text.includes(fragment), `${name}: 页里留着秘密片段 ${fragment}`);
      }
    }
    assert.ok(pages.join("").includes("[REDACTED"), `${name}: 秘密被占位符替换`);
    assert.ok(pages.every((t) => Buffer.byteLength(t, "utf8") <= OWNER_EVENT_PAGE_MAX_BYTES));
  }
});

test("控制字符：C0 / C1 / DEL 一律清掉（换行与制表符保留）；行的长度有界", async () => {
  const page = await W.activity("run_secret");
  const ctl = rowAt(page, S.secCtl);
  assert.ok(ctl.summary.includes("red") && ctl.summary.includes("bell") && ctl.summary.includes("del"));
  assertNoControlChars(page);
  assertNoControlChars(await W.activity("run_shapes"));
  assertNoControlChars(await W.event("run_secret", S.secCtl, "message"));
  const big = rowAt(await W.activity("run_page"), S.pageBig);
  assert.ok(big.body.head[0].length <= OWNER_ACTIVITY_LINE_MAX_CHARS, "单行再长也被限长");
  assert.equal(big.truncated, true, "被限长的行标 truncated，提示可取全文");
  assert.equal(big.body.totalLines, 1);
});

test("整个世界扫一遍：每个运行、每个筛选、每个可寻址事件的响应都不带临时根、工作树、令牌与未脱敏的秘密", async () => {
  const runs = ["run_long", "run_shapes", "run_gap", "run_filter", "run_legacy", "run_noseq", "run_nowt", "run_dupstart", "run_iso", "run_page", "run_secret"];
  for (const runId of runs) {
    for (const filter of OWNER_ACTIVITY_FILTERS) {
      const r = await W.get(`/api/worker/activity?runId=${runId}&filter=${filter}`);
      assert.equal(r.status, 200, `${runId} ${filter}`);
      // 隔离违规事件自己的路径是已批准的例外（共用投影处理过的"越界去了哪里"）；别处不许有外部绝对路径。
      assertSafeText(r.body, { allowOutsidePaths: runId === "run_iso" });
      assertNoControlChars(jsonOf(r));
    }
  }
});

// ===== 7. 直接调用（应用层）：投影只读、不改传入的事件 =====

test("应用层：projectWorkerActivity / projectWorkerEvent 不改传入的事件数组，也不依赖 HTTP", () => {
  const b = builder("run_unit");
  b.add("run.started", { backend: "claude-code", worktreePath: "C:\\w\\run_unit" });
  say(b, "hello\nworld");
  output(b, "x", "o\n");
  // 旧档形状的 tool_use：用 name、没有输入——摘要退到工具名。
  b.add("run.event", { kind: "tool_use", name: "Read", toolCallId: "legacy" });
  const frozen = JSON.stringify(b.events);
  const page = projectWorkerActivity({ runId: "run_unit", events: b.events, env: {} });
  assert.deepEqual(page.rows.map((r) => r.code), ["MSG", "OUT", "TOOL"]);
  assert.deepEqual([page.rows[2].tool, page.rows[2].summary], ["Read", "Read"]);
  assert.equal(page.total, 4);
  const full = projectWorkerEvent({ runId: "run_unit", events: b.events, seq: 2, part: "message", page: 1, env: {} });
  assert.deepEqual([full.text, full.totalPages, full.totalBytes], ["hello\nworld", 1, 11]);
  assert.equal(projectWorkerEvent({ runId: "run_unit", events: b.events, seq: 2, part: "output", page: 1, env: {} }), null);
  assert.equal(JSON.stringify(b.events), frozen, "事件原样未动");
  // 别的运行的事件不进这条运行的时间线。
  const foreign = [...b.events, { type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "intruder" }], seq: 9, runId: "run_other", ts: iso(T0) }];
  assert.ok(!JSON.stringify(projectWorkerActivity({ runId: "run_unit", events: foreign, env: {} })).includes("intruder"));
});

// =====================================================================
// 第 141c 批修正一
// =====================================================================

// ===== 修正 1：结构化错误详情里的秘密 =====

test("修正1·结构化错误：detail 是对象时先逐个字符串（键、值、嵌套值）脱敏再序列化——含引号与反斜杠的秘密在摘要、列表文本、全文里都不留（含转义后的形状）", async () => {
  const row = rowAt(await W.activity("run_errdetail"), S.errDetail);
  const full = await W.event("run_errdetail", S.errDetail, "error");
  const bodies = [JSON.stringify(row), JSON.stringify(full), (await W.get(W.eventUrl("run_errdetail", S.errDetail, "error"))).body];
  for (const body of bodies) {
    for (const form of secretForms(QUOTED_SECRET)) assert.ok(!body.includes(form), `留着秘密的形状 ${form}`);
    assert.ok(!body.includes("ef-secret-77"), "秘密的任何一段都不留");
    assert.ok(!body.includes(EXACT_SECRET));
    assertSafeText(body);
  }
  assert.ok(row.text.includes("[REDACTED:OWNER_TEST_QUOTED_SECRET]"), "确实是被替换的，不是丢了");
  assert.ok(row.text.includes("[REDACTED:OWNER_TEST_API_KEY]"), "同一份对象里的普通精确秘密照样替换");
  assert.ok(row.text.includes("keyed"), "键被替换后，值照给");
  // 序列化后的整段仍是合法 JSON（遍历只替换了字符串，没有破坏结构）。
  const parsed = JSON.parse(full.text);
  assert.deepEqual(Object.keys(parsed).sort(), ["[REDACTED:OWNER_TEST_QUOTED_SECRET]", "cmd", "nested", "note"].sort());
  assert.equal(parsed.nested.list.length, 2);
});

// ===== 修正 2：旧档与混合转录能翻页 =====

/** 一路按 older.beforeSeq 翻到头，返回按时间正序（最老的页在前）的各页；游标必须每页前进。 */
async function pageAll(runId, limit = 200) {
  const pages = [];
  let query = `limit=${limit}`;
  for (let guard = 0; guard < 60; guard += 1) {
    const page = await W.activity(runId, query);
    pages.unshift(page);
    if (!page.older.available) break;
    assert.ok(Number.isInteger(page.older.beforeSeq), "older.available=true 就必须给得出 beforeSeq（否则前端只能原地重复）");
    const next = `limit=${limit}&beforeSeq=${page.older.beforeSeq}`;
    assert.notEqual(next, query, "游标必须前进");
    query = next;
  }
  return pages;
}
const summariesOf = (pages) => pages.flatMap((page) => eventRows(page).map((r) => r.summary));
const numbered = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

test("修正2·混合转录：300 条带号 + 300 条无号、limit=200，一页页取完全部事件——每条恰一次、按时间正序（有号在前 / 无号在前两种排法）", async () => {
  assert.deepEqual([...OWNER_OLDER_REASONS], ["unnumbered", "capped"]);
  assert.equal(OWNER_ACTIVITY_PAGE_MAX, 1000);
  const a = await pageAll("run_mixed_a");
  assert.deepEqual(summariesOf(a), ["pending", ...numbered("m", 300), ...numbered("u", 300)], "有号在前、无号在后");
  assert.ok(a.at(-1).rows.length > 200 && a.at(-1).rows.length <= OWNER_ACTIVITY_PAGE_MAX, "最新一页往前取到最近的有号事件：可以多于 limit，但有上限");
  assert.equal(a.at(-1).older.beforeSeq, 304, "指向那个有号事件（m300 的 seq）");
  assert.deepEqual(a.at(-1).older.reason, null);
  const b = await pageAll("run_mixed_b");
  assert.deepEqual(summariesOf(b), ["pending", ...numbered("u", 300), ...numbered("m", 300)], "无号在前、有号在后");
  for (const page of [...a, ...b]) {
    assert.ok(page.rows.length <= OWNER_ACTIVITY_PAGE_MAX);
    assert.deepEqual(gapsOf(page), [], "没有事件号的事件不造出缺口");
  }
  assert.deepEqual(b[0].older, { available: false, beforeSeq: null, reason: null });
});

test("修正2·纯无号转录：older.available=false 并写明原因 unnumbered，页一直取到最早；一段超过页上限只给最新的页上限个单位并标 capped", async () => {
  const pure = await W.activity("run_unnumbered", "limit=200");
  assert.deepEqual(summariesOf([pure]), ["pending", ...numbered("u", 300)], "窗口之前全无号：整段放进这一页，比 limit 多");
  assert.deepEqual(pure.older, { available: false, beforeSeq: null, reason: "unnumbered" });
  assert.deepEqual(pure.range, { fromSeq: null, toSeq: null });

  const big = await W.activity("run_unnumbered_big", "limit=200");
  assert.equal(big.rows.length, OWNER_ACTIVITY_PAGE_MAX);
  assert.deepEqual(big.older, { available: false, beforeSeq: null, reason: "capped" });
  assert.equal(eventRows(big).at(-1).summary, "u1200", "给的是最新的一段");

  // 有号事件在更早处、中间隔着超过页上限的无号事件：这一页只给最新的页上限个，older 指向那个有号事件，原因 capped。
  const capped = await W.activity("run_capped", "limit=200");
  assert.equal(capped.rows.length, OWNER_ACTIVITY_PAGE_MAX);
  assert.deepEqual(capped.older, { available: true, beforeSeq: 4, reason: "capped" });
  const rest = await W.activity("run_capped", "limit=200&beforeSeq=4");
  assert.deepEqual(summariesOf([rest]), ["pending"]);
  assert.deepEqual(rest.older, { available: false, beforeSeq: null, reason: null });
});

// ===== 修正 3：缺口、折叠、预算、事件号范围 =====

/** 直接用事件数组调投影（不经读模型）：每条事件一个消息，seq 由 seqs 指定（undefined = 没有事件号）。 */
function messagesWithSeqs(runId, seqs) {
  const b = builder(runId);
  seqs.forEach((seq, i) => say(b, `s${i}`, { seq }));
  return b.events;
}

test("修正3·缺口按出现过的事件号算：冲突号不挡缺口（1,3,3,5,5 报 #2 与 #4 缺失），冲突状态照留", () => {
  const page = projectWorkerActivity({ runId: "run_u1", events: messagesWithSeqs("run_u1", [1, 3, 3, 5, 5]), env: {} });
  const shape = page.rows.map((r) => (r.row === "gap" ? `gap${r.fromSeq}-${r.toSeq}x${r.count}` : `${r.seq}:${r.seqState}`));
  assert.deepEqual(shape, ["1:ok", "gap2-2x1", "3:conflict", "3:conflict", "gap4-4x1", "5:conflict", "5:conflict"]);
  // 倒退的号（5 之后又来 4）占着自己的号，不让相邻的缺口消失，也不凭空多出缺口。
  const back = projectWorkerActivity({ runId: "run_u1b", events: messagesWithSeqs("run_u1b", [1, 2, 6, 4]), env: {} });
  assert.deepEqual(
    gapsOf(back).sort((x, y) => x.fromSeq - y.fromSeq),
    [{ row: "gap", fromSeq: 3, toSeq: 3, count: 1 }, { row: "gap", fromSeq: 5, toSeq: 5, count: 1 }],
    "缺口按出现过的号码（1、2、4、6）算：3 与 5 各缺一次，不多不少",
  );
  assert.deepEqual(eventRows(back).map((r) => `${r.seq}:${r.seqState}`), ["1:ok", "2:ok", "6:ok", "4:conflict"]);
});

test("修正3·折叠遇到冲突号或缺口要切开：fromSeq / toSeq / count 与实际吸收的事件一致；没有事件号的只和没有事件号的折", () => {
  const b = builder("run_u2");
  for (const [seq, status] of [[1, "initialized"], [2, "streaming"], [4, "streaming"], [4, "process_active"], [5, "provider_retry"], [7, "files_changed"]]) {
    runtime(b, status, { seq });
  }
  runtime(b, "process_active", { seq: undefined });
  runtime(b, "streaming", { seq: undefined });
  const page = projectWorkerActivity({ runId: "run_u2", events: b.events, env: {} });
  const shape = page.rows.map((r) => (r.row === "fold"
    ? `fold:${r.seqState}:${r.fromSeq}-${r.toSeq}x${r.count}:${r.status}`
    : r.row === "gap" ? `gap${r.fromSeq}-${r.toSeq}` : `?${r.row}`));
  assert.deepEqual(shape, [
    "fold:ok:1-2x2:streaming", // 1、2 连号，一起折
    "gap3-3", // 缺口打断
    "fold:conflict:4-4x1:streaming", // 冲突号各自一行，不拿来画区间
    "fold:conflict:4-4x1:process_active",
    "fold:ok:5-5x1:provider_retry", // 冲突的下一条即使是 ok 也不并进冲突行
    "gap6-6",
    "fold:ok:7-7x1:files_changed",
    "fold:missing:null-nullx2:streaming", // 没有事件号的相邻两条一起折，区间为 null
  ]);
  assert.equal(page.hidden.folded, 8, "被折叠的事件数 = 各行 count 之和");
  assert.equal(page.rows.filter((r) => r.row === "fold").reduce((sum, r) => sum + r.count, 0), 8);
});

test("修正3·缺口行计入 limit 预算：稀疏事件号的转录 limit=1 只给 1 行；一路翻页每页不超过 limit，事件与缺口恰好盖满号码段", () => {
  const sparse = (n) => messagesWithSeqs("run_sparse", Array.from({ length: n }, (_, i) => 2 * i + 1));
  const big = sparse(30_001);
  const one = projectWorkerActivity({ runId: "run_sparse", events: big, limit: 1, env: {} });
  assert.equal(one.rows.length, 1, "30 001 个事件、30 000 个缺口，limit=1 也只给 1 行");
  // 筛选把事件全筛掉后，剩下的单位全是缺口：同样受 limit 约束。
  const gapsOnly = projectWorkerActivity({ runId: "run_sparse", events: big, limit: 1, filter: "errors", env: {} });
  assert.ok(gapsOnly.rows.length <= 1, `只剩缺口时给了 ${gapsOnly.rows.length} 行`);

  const events = sparse(6000);
  const covered = new Map(); // 号码 → 被谁盖住
  let beforeSeq;
  let pages = 0;
  for (; pages < 200; pages += 1) {
    const page = projectWorkerActivity({ runId: "run_sparse", events, limit: 200, ...(beforeSeq === undefined ? {} : { beforeSeq }), env: {} });
    assert.ok(page.rows.length <= 200, `第 ${pages + 1} 页 ${page.rows.length} 行`);
    for (const r of page.rows) {
      const [from, to] = r.row === "gap" ? [r.fromSeq, r.toSeq] : [r.seq, r.seq];
      for (let n = from; n <= to; n += 1) {
        assert.ok(!covered.has(n), `号码 ${n} 出现在两页里`);
        covered.set(n, r.row);
      }
    }
    if (!page.older.available) break;
    assert.ok(page.older.beforeSeq < (beforeSeq ?? Infinity), "游标前进");
    beforeSeq = page.older.beforeSeq;
  }
  assert.equal(covered.size, 11_999, "1 … 11 999 每个号码恰好被一行盖住（奇数是事件、偶数是缺口）");
  assert.ok([...covered].every(([n, kind]) => (n % 2 === 1) === (kind === "event")));
});

test("修正3·事件号的合法范围与路由同一个界（九位十进制）：范围外按无号处理，列表不给路由会拒绝的 beforeSeq", async () => {
  assert.equal(OWNER_SEQ_MAX, 999_999_999);
  const b = builder("run_u3");
  for (let i = 1; i <= 120; i += 1) say(b, `ok${i}`, { seq: i });
  for (const [i, seq] of [1_000_000_000, 5_000_000_000, 0, -3, 1.5, "7", 999_999_999].entries()) say(b, `odd${i}`, { seq });
  let beforeSeq;
  const seen = [];
  for (let guard = 0; guard < 20; guard += 1) {
    const page = projectWorkerActivity({ runId: "run_u3", events: b.events, limit: 30, ...(beforeSeq === undefined ? {} : { beforeSeq }), env: {} });
    seen.unshift(...eventRows(page).map((r) => `${r.summary}:${r.seqState}`));
    if (page.older.beforeSeq !== null) assert.ok(page.older.beforeSeq <= OWNER_SEQ_MAX, `给出了路由会拒绝的 beforeSeq ${page.older.beforeSeq}`);
    if (!page.older.available) break;
    beforeSeq = page.older.beforeSeq;
  }
  assert.equal(seen.length, 127, "每条恰一次");
  for (const [i, state] of [[0, "missing"], [1, "missing"], [2, "missing"], [3, "missing"], [4, "missing"], [5, "missing"], [6, "ok"]]) {
    assert.ok(seen.includes(`odd${i}:${state}`), `odd${i} 应是 ${state}`);
  }
  // 路由：九位十进制放行，十位拒绝。
  assert.equal((await W.get(`/api/worker/activity?runId=run_long&beforeSeq=${OWNER_SEQ_MAX}`)).status, 200);
  assert.equal((await W.get(`/api/worker/activity?runId=run_long&beforeSeq=${OWNER_SEQ_MAX + 1}`)).status, 400);
  assert.equal((await W.get(W.eventUrl("run_long", OWNER_SEQ_MAX + 1, "message"))).status, 400);
  assert.equal((await W.get(W.eventUrl("run_long", OWNER_SEQ_MAX, "message"))).status, 404, "合法但没有这条事件：404");
});

// ===== 修正 4：单请求工作量有界 =====

test("修正4·超长输出只处理头尾窗口：处理过的原文长度有界、总行数在原文上数、标 truncated；跨在窗口截点上的秘密被完整替换", () => {
  assert.ok(OWNER_ACTIVITY_WINDOW_CHARS >= OWNER_OUTPUT_HEAD_LINES * OWNER_ACTIVITY_LINE_MAX_CHARS, "窗口装得下头 20 行");
  const span = OWNER_ACTIVITY_WINDOW_CHARS + OWNER_ACTIVITY_WINDOW_MARGIN_CHARS;
  // 前 19 行各 420 字，第 20 行从原文第 7980 字起：秘密落在第 8180–8207 字，正好跨在窗口上限（8192）上。
  const first19 = `${"a".repeat(419)}\n`.repeat(19);
  const line20 = `${"b".repeat(200)}${EXACT_SECRET}${"c".repeat(100)}\n`;
  assert.ok(first19.length === 7980 && 7980 + 200 < OWNER_ACTIVITY_WINDOW_CHARS && 7980 + 200 + EXACT_SECRET.length > OWNER_ACTIVITY_WINDOW_CHARS);
  const filler = "filler line of text\n".repeat(1_000_000); // 20 MB
  // 结尾：秘密的起点在"尾窗口取的原文起点"之前 10 个字，被窗口边缘切半。
  const tailPart = `${EXACT_SECRET}${"x".repeat(span + 10 - EXACT_SECRET.length - 1)}\n`;
  const raw = `${first19}${line20}${filler}${tailPart}`;
  assert.ok(raw.length > 20_000_000);
  const b = builder("run_big");
  b.add("run.event", { kind: "tool_result", tool: "big1", output: raw, isError: false });
  const seen = [];
  const page = projectWorkerActivity({ runId: "run_big", events: b.events, env: SERVER_ENV, onProcessText: (n) => seen.push(n) });
  const row = page.rows[0];

  assert.ok(seen.length > 0, "测试接缝在位：每次交给脱敏管道的原文长度都记下来了");
  assert.ok(Math.max(...seen) <= span, `单次处理的原文 ${Math.max(...seen)} 字，窗口只有 ${span} 字`);
  assert.ok(seen.reduce((sum, n) => sum + n, 0) <= 2 * span + 4096, "一共处理的原文远小于 20 MB（头尾两个窗口加几个短标签）");
  assert.equal(row.truncated, true, "只处理了窗口：标 truncated");
  assert.equal(row.body.totalLines, 19 + 1 + 1_000_000 + 1, "总行数在原文上数");
  assert.equal(row.body.omittedLines, row.body.totalLines - row.body.head.length - row.body.tail.length);
  assert.equal(row.body.head.length, OWNER_OUTPUT_HEAD_LINES, "头 20 行照给");
  const shown = JSON.stringify(row);
  for (const fragment of [EXACT_SECRET, EXACT_SECRET.slice(0, 12), EXACT_SECRET.slice(-12)]) {
    assert.ok(!shown.includes(fragment), `窗口截点上的秘密留下了片段 ${fragment}`);
  }
  assert.ok(row.body.head[19].includes("[REDACTED"), "第 20 行里的秘密是整段被替换的（截断发生在替换之后）");
});

test("修正4·一次请求整段处理的原文有总预算：超过预算的后几条也只处理窗口", () => {
  const each = 800 * 1024; // 低于单条整段处理的上限、高于"一律整段"的下限
  assert.ok(each < Activity.OWNER_ACTIVITY_RAW_MAX_CHARS && each > OWNER_ACTIVITY_FULL_ALWAYS_MAX_CHARS);
  const b = builder("run_budget");
  const count = Math.ceil(OWNER_ACTIVITY_REQUEST_RAW_BUDGET_CHARS / each) + 3;
  for (let i = 0; i < count; i += 1) b.add("run.event", { kind: "tool_result", tool: `t${i}`, output: `${"line of output\n".repeat(Math.ceil(each / 15))}`, isError: false });
  const seen = [];
  const page = projectWorkerActivity({ runId: "run_budget", events: b.events, env: {}, onProcessText: (n) => seen.push(n) });
  assert.ok(seen.length > 0, "测试接缝在位");
  const processed = seen.reduce((sum, n) => sum + n, 0);
  assert.equal(page.rows.length, count);
  assert.ok(processed <= OWNER_ACTIVITY_REQUEST_RAW_BUDGET_CHARS + each + count * 2 * (OWNER_ACTIVITY_WINDOW_CHARS + OWNER_ACTIVITY_WINDOW_MARGIN_CHARS), `处理了 ${processed} 字`);
  assert.ok(page.rows.slice(-3).every((r) => r.truncated === true), "预算用完之后的行标 truncated");
  assert.equal(page.rows[0].truncated, true, "头 20 行 + 尾 20 行之外还有行");
});

test("修正4·全文缓存：同一事件连续取两页，第二页命中缓存、不再处理原文；转录身份变了就重算", () => {
  const b = builder("run_cache");
  output(b, "c1", lines(6000, "cache line")); // 约 80 KB，3 页
  const events = b.events;
  const cache = createFullTextCache();
  const seen = [];
  const ask = (page, identity) => projectWorkerEvent({
    runId: "run_cache", events, seq: 1, part: "output", page, env: {}, cache, identity, onProcessText: (n) => seen.push(n),
  });
  const p1 = ask(1, "hash-a");
  assert.equal(p1.totalPages, 3);
  assert.deepEqual({ ...cache.stats }, { hits: 0, misses: 1, evictions: 0 });
  const processedOnce = seen.reduce((sum, n) => sum + n, 0);
  assert.ok(processedOnce > 70_000, "第一次整段处理了原文");
  const p2 = ask(2, "hash-a");
  assert.equal(seen.reduce((sum, n) => sum + n, 0), processedOnce, "第二页没有再处理原文");
  assert.deepEqual({ ...cache.stats }, { hits: 1, misses: 1, evictions: 0 });
  assert.equal(`${p1.text}${p2.text}${ask(3, "hash-a").text}`, lines(6000, "cache line"), "分页拼起来还是全文");
  assert.equal(ask(4, "hash-a"), null, "越界页也不重算");
  assert.equal(cache.stats.hits, 3, "第 2、3、4 次都命中");
  // 转录变了（身份不同）：旧条目不再命中，重新处理。
  ask(1, "hash-b");
  assert.equal(cache.stats.misses, 2);
  assert.ok(seen.reduce((sum, n) => sum + n, 0) >= 2 * processedOnce - 1000);
  // 不给身份 / 不给缓存：不缓存、照常工作。
  assert.equal(ask(1, null).page, 1);
  assert.equal(cache.stats.misses, 2, "没有身份就不碰缓存");
});

test("修正4·缓存有字节上限、最近最少使用淘汰；比上限还大的条目不缓存（每条记录另计固定开销）", () => {
  const overhead = Activity.OWNER_EVENT_CACHE_ENTRY_OVERHEAD_BYTES;
  assert.ok(Number.isInteger(overhead) && overhead > 0, "每条记录有具名的固定开销");
  const cost = 40 + overhead;
  const cache = createFullTextCache({ maxBytes: 2 * cost + 10 });
  const entry = (n) => ({ totalBytes: n });
  assert.deepEqual(cache.getOrCompute("a", () => entry(40)), entry(40));
  cache.getOrCompute("b", () => entry(40));
  cache.getOrCompute("a", () => assert.fail("a 应命中")); // a 变成最近使用
  cache.getOrCompute("c", () => entry(40)); // 三条放不下：淘汰最久没用的 b
  assert.equal(cache.stats.evictions, 1);
  assert.equal(cache.bytes, 2 * cost);
  cache.getOrCompute("a", () => assert.fail("a 还在"));
  let recomputed = 0;
  cache.getOrCompute("b", () => { recomputed += 1; return entry(40); });
  assert.equal(recomputed, 1, "b 被淘汰过，重新算");
  const huge = 2 * cost + 11;
  assert.equal(cache.getOrCompute("huge", () => entry(huge)).totalBytes, huge);
  assert.equal(cache.bytes <= 2 * cost + 10, true, "太大的条目不进缓存");
  assert.equal(cache.getOrCompute("none", () => null), null, "取不到的不缓存");
});

test("修正二·缓存限制实际驻留量：零字节正文也计固定开销、另设条目数上限，任一超出就淘汰（2000 个空正文条目后条目数不超上限）", () => {
  const { OWNER_EVENT_CACHE_MAX_ENTRIES, OWNER_EVENT_CACHE_MAX_BYTES } = Activity;
  assert.ok(Number.isInteger(OWNER_EVENT_CACHE_MAX_ENTRIES) && OWNER_EVENT_CACHE_MAX_ENTRIES > 0 && OWNER_EVENT_CACHE_MAX_ENTRIES < 2000);
  const b = builder("run_empty");
  for (let i = 0; i < 2000; i += 1) output(b, `e${i}`, "");
  const cache = createFullTextCache();
  for (let seq = 1; seq <= 2000; seq += 1) {
    const r = projectWorkerEvent({ runId: "run_empty", events: b.events, seq, part: "output", env: {}, cache, identity: "h" });
    assert.deepEqual([r.text, r.totalBytes, r.totalPages], ["", 0, 1]);
  }
  assert.ok(cache.size <= OWNER_EVENT_CACHE_MAX_ENTRIES, `缓存里有 ${cache.size} 条空正文条目`);
  assert.ok(cache.bytes <= OWNER_EVENT_CACHE_MAX_BYTES);
  assert.ok(cache.stats.evictions >= 2000 - OWNER_EVENT_CACHE_MAX_ENTRIES, "多出来的按最近最少使用淘汰");
  // 条目数上限可单独指定；零字节条目也按固定开销计入总字节。
  const small = createFullTextCache({ maxEntries: 5 });
  for (let i = 0; i < 20; i += 1) small.getOrCompute(`k${i}`, () => ({ totalBytes: 0 }));
  assert.equal(small.size, 5);
  assert.equal(small.bytes, 5 * Activity.OWNER_EVENT_CACHE_ENTRY_OVERHEAD_BYTES);
  const byBytes = createFullTextCache({ maxBytes: 3 * Activity.OWNER_EVENT_CACHE_ENTRY_OVERHEAD_BYTES });
  for (let i = 0; i < 20; i += 1) byBytes.getOrCompute(`k${i}`, () => ({ totalBytes: 0 }));
  assert.equal(byBytes.size, 3, "只有总字节上限时，零字节条目也靠固定开销被限住");
});

test("修正4·读模型给转录身份（字节的 sha256），全文接口按它失效：转录被改写后第二次请求看到新文本", async () => {
  const model = createOwnerReadModel({ runDir: W.store.runDir });
  assert.equal(await model.readRunTranscript("run_mutable"), null, "首次 refresh 之前一律 null");
  await model.refresh();
  const t1 = await model.readRunTranscript("run_mutable");
  assert.match(t1.identity, /^[0-9a-f]{64}$/);
  assert.deepEqual(t1.events, await model.readRunEvents("run_mutable"), "与 readRunEvents 同一次读取的同一份事件");
  assert.equal(await model.readRunTranscript("run_nobody"), null);
  const again = await model.readRunTranscript("run_mutable");
  assert.equal(again.identity, t1.identity, "同样的内容身份相同");

  const before = await W.event("run_mutable", S.mutable, "output");
  assert.equal(before.text, "version one\n");
  assert.equal((await W.event("run_mutable", S.mutable, "output")).text, "version one\n", "第二次取（命中缓存）内容不变");
  // 同一个 seq、同样长度的另一份内容：身份变了，不能拿旧缓存回答。
  const b = builder("run_mutable");
  head(b, W.ctx);
  output(b, "mut", "version two\n");
  W.store.write("run_mutable", b.events);
  const after = await W.event("run_mutable", S.mutable, "output");
  assert.equal(after.text, "version two\n", "转录变了，缓存按身份失效");
  const t2 = await model.readRunTranscript("run_mutable");
  assert.notEqual(t2.identity, t1.identity);
});

// ===== 修正 5：诚实性的小口子 =====

// ===== 修正二·3：截断要如实标出 =====

/** 一条 run.error（detail 给定）的列表行与全文（直接用事件数组调投影）。 */
function errorRowAndFull(detail) {
  const b = builder("run_detail");
  b.add("run.error", { phase: "wait", detail });
  const page = projectWorkerActivity({ runId: "run_detail", events: b.events, env: {} });
  const full = projectWorkerEvent({ runId: "run_detail", events: b.events, seq: 1, part: "error", env: {} });
  return { row: page.rows[0], full };
}

test("修正二·结构化 detail 被裁剪（字段、数组元素、嵌套层数）时，列表行标 truncated，全文末尾加一句固定的省略说明；没被裁剪的不加", () => {
  const note = Activity.OWNER_DETAIL_TRUNCATED_NOTE;
  assert.equal(typeof note, "string");
  assert.ok(note.length > 0 && !note.includes("\n"));
  const fields = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, `v${i}`]));

  const over = errorRowAndFull(fields(201));
  assert.equal(over.row.truncated, true, "201 个字段：裁掉了最后一个，不能静默");
  assert.ok(over.full.text.endsWith(`\n${note}`), "全文末尾是固定的省略说明");
  const keys = Object.keys(JSON.parse(over.full.text.split("\n")[0]));
  assert.equal(keys.length, 200);
  assert.ok(!keys.includes("f200"), "被裁掉的是第 201 个");
  assert.ok(over.row.text.endsWith(note), "短到放得进列表行的文本里也带着说明");

  const exact = errorRowAndFull(fields(200));
  assert.equal(exact.row.truncated, false, "恰 200 个字段：没有裁剪，不标");
  assert.ok(!exact.full.text.includes(note));
  assert.equal(Object.keys(JSON.parse(exact.full.text)).length, 200);

  const list = errorRowAndFull({ items: Array.from({ length: 201 }, (_, i) => i) });
  assert.equal(list.row.truncated, true, "201 个数组元素同理");
  assert.equal(JSON.parse(list.full.text.split("\n")[0]).items.length, 200);

  let deep = "leaf";
  for (let i = 0; i < 8; i += 1) deep = { next: deep };
  const nested = errorRowAndFull(deep);
  assert.equal(nested.row.truncated, true, "嵌套超过遍历深度：被写成 […]，要标出");
  assert.ok(nested.full.text.includes("[…]") && nested.full.text.endsWith(`\n${note}`));
});

test("修正二·头尾窗口按原文的行范围去重：两个窗口取到重叠的原文时不重复显示同一行，omittedLines 按实际没显示的行数算", () => {
  // 5 行、每行约 219 KiB 的带引号路径：折路径把每个约 900 字的路径压成 "…/f.txt"，整份文本处理后只剩 13 KiB——
  // 窗口为了凑够字数一路放大，头尾两个窗口取到的原文重叠。
  const unit = `"C:\\${"p".repeat(900)}\\f.txt" `;
  const raw = [1, 2, 3, 4, 5].map((n) => `L${n} ${unit.repeat(240)}`).join("\n") + "\n";
  assert.ok(raw.length > Activity.OWNER_ACTIVITY_RAW_MAX_CHARS && raw.length < 2 * Activity.OWNER_ACTIVITY_RAW_MAX_CHARS);
  const b = builder("run_overlap");
  output(b, "ov", raw);
  const row = projectWorkerActivity({ runId: "run_overlap", events: b.events, env: {} }).rows[0];
  const shown = [...row.body.head, ...row.body.tail].map((line) => line.slice(0, 2));
  assert.deepEqual(shown, ["L1", "L2", "L3", "L4", "L5"], `同一行重复显示了：${shown}`);
  assert.equal(row.body.totalLines, 5);
  assert.equal(row.body.omittedLines, 0, "5 行全显示了，没有省略");
  assert.ok(!JSON.stringify(row).includes("C:\\"), "路径照样折掉了");
});

test("修正二·omittedLines 算不准时给 null：窗口里的脱敏改变了行数（跨行秘密）；LF、CRLF、CR 混用的行数照实数；整段处理时按处理后的文本算", () => {
  const pem = ["-----BEGIN ", "RSA PRIVATE", " KEY-----"].join("");
  const pemEnd = ["-----END ", "RSA PRIVATE", " KEY-----"].join("");
  const key = `${pem}\r\nMIIEowIBAAKCAQEA1234567890abcdef\nMIIEowIBAAKCAQEA1234567890abcdef\r${pemEnd}\r\n`;

  // 小文本（整段处理）：行数按处理后的文本算（跨行秘密收成一行 [REDACTED]），省略行数是准的。
  const small = builder("run_mixed_small");
  output(small, "ms", `head\r\nsecond\n${key}after\rcr\n`);
  const smallRow = projectWorkerActivity({ runId: "run_mixed_small", events: small.events, env: {} }).rows[0];
  assert.deepEqual(smallRow.body, { head: ["head", "second", "[REDACTED]", "after", "cr"], tail: [], totalLines: 5, omittedLines: 0 });
  assert.ok(!JSON.stringify(smallRow).includes("MIIEow"));

  // 超过整段处理上限（只处理头尾窗口）：总行数在原文上数（LF、CRLF、CR 各算一个行终止符）；窗口里的跨行秘密
  // 被收成一行，窗口处理前后行数对不上——省略了多少行算不准，给 null，不给一个错的数。
  const big = builder("run_mixed_big");
  const bigRaw = `line one\r\nline two\n${key}line after\rcr line\n${"filler\n".repeat(160_000)}`;
  assert.ok(bigRaw.length > Activity.OWNER_ACTIVITY_RAW_MAX_CHARS);
  output(big, "mb", bigRaw);
  const bigRow = projectWorkerActivity({ runId: "run_mixed_big", events: big.events, env: {} }).rows[0];
  assert.equal(bigRow.body.totalLines, bigRaw.match(/\r\n|\r|\n/g).length, "总行数在原文上数");
  assert.equal(bigRow.body.omittedLines, null);
  assert.equal(bigRow.truncated, true);
  assert.deepEqual(bigRow.body.head.slice(0, 5), ["line one", "line two", "[REDACTED]", "line after", "cr line"]);
  assert.ok(!JSON.stringify(bigRow).includes("MIIEow"));

  // 窗口处理没有改变行数时，省略行数是准的。
  const plain = builder("run_plain_big");
  output(plain, "pb", lines(200_000, "x"));
  const plainRow = projectWorkerActivity({ runId: "run_plain_big", events: plain.events, env: {} }).rows[0];
  assert.ok(plainRow.body.head.length === 20 && plainRow.body.tail.length === 20);
  assert.equal(plainRow.body.totalLines, 200_000);
  assert.equal(plainRow.body.omittedLines, 199_960);
});

test("修正5·TOOL 行摘要被限长时 truncated 按限长前的长度判；工具名被限长也算", async () => {
  const page = await W.activity("run_honest");
  const long = rowAt(page, S.toolLong);
  assert.ok(long.summary.length <= OWNER_ACTIVITY_LINE_MAX_CHARS && long.summary.endsWith("…"), "摘要被限长到 400 字");
  assert.equal(long.truncated, true);
  const short = rowAt(page, S.toolShort);
  assert.deepEqual([short.summary, short.truncated], ["Bash echo hi", false]);
  const name = rowAt(page, S.toolLongName);
  assert.equal(name.tool.length, OWNER_ACTIVITY_LABEL_MAX_CHARS);
  assert.equal(name.truncated, true);
});

test("修正5·写文件的相对路径超过上限给 [path_withheld]，不静默截成指向别处的路径；恰好等于上限的照给", async () => {
  const page = await W.activity("run_honest");
  assert.equal(OWNER_PATH_MAX_CHARS, 256);
  assert.equal(rowAt(page, S.pathMax).path, `src/${"a".repeat(252)}`, "恰 256 字：完整给出");
  assert.equal(rowAt(page, S.pathMax).path.length, OWNER_PATH_MAX_CHARS);
  assert.equal(rowAt(page, S.pathOver).path, OWNER_PATH_WITHHELD, "257 字：不给");
  assert.equal(rowAt(page, S.pathOverRel).path, OWNER_PATH_WITHHELD, "相对写法也一样");
  assert.equal(rowAt(page, S.pathOk).path, "src/ok.txt");
});

test("修正5·Windows 盘符相对路径（C:outside/../src/a.txt、C:foo、c:）基准目录证明不了，一律 [path_withheld]；绝对路径的既有判定不变", async () => {
  const page = await W.activity("run_honest");
  for (const name of ["driveRel1", "driveRel2", "driveRel3", "driveAbsOutside"]) {
    assert.equal(rowAt(page, S[name]).path, OWNER_PATH_WITHHELD, name);
  }
  assert.equal(rowAt(page, S.pathOk).path, "src/ok.txt", "树内路径照常");
  // Lead 侧的 deriveRelativePath 行为不动（`..` 会把 `C:outside` 当目录吃掉，得到 src/a.txt）：这一形状在 Owner 投影里先判掉。
  const { deriveRelativePath } = await import("../../src/application/runScopeObservation.js");
  assert.equal(deriveRelativePath("C:outside/../src/a.txt", "C:\\wt\\run"), "src/a.txt", "共用的 deriveRelativePath 照旧（Lead 侧不改）");
});
