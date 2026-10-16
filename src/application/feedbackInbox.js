// src/application/feedbackInbox.js
//
// 本机反馈收件箱：宿主项目的 Lead 把 WAO 的缺陷或别扭之处写进来，WAO 开发 Lead
// 在同一台机器上读它。不用 GitHub Issues 的理由：仓库是公开的，宿主项目的名字、
// 路径与业务内容不能离开本机。收件箱是 `<根>/.wao/inbox/`，下分 `open/` 与
// `closed/`，另有 `ids/` 登记每个分出去的 id（空文件，永不删除，保证 id 不复用）；
// 它不进 git（`.gitignore` 的 `.wao/*` 已忽略 `.wao/decisions/` 以外的一切）。
//
// 收件箱根的解析不看 cwd：
//   1. 先取 WAO 代码所在的检出 packageRoot——由本模块自身的 import.meta.url
//      推出。全局 `wao`、`scripts/wao-cli.cmd`、在任意工作树里 `npm run cli`
//      执行的都是某个检出里的代码，以代码位置为准。（不依赖 WAO_INSTALL_ROOT：
//      scripts/wao-cli.cmd 不注入它，而宿主文档推荐的正是这个入口。）
//   2. packageRoot 在 Git 仓里时取该仓的主检出：`git worktree list --porcelain`
//      的首条，与 scripts/hygiene.mjs 的 primaryWorktreePath 同一判据。开发
//      Lead 在 .dev/wt/* 或 .wao-worktrees/* 里看到的因此也是主检出的收件箱。
//   3. 不在 Git 仓里（安装形态）就用 packageRoot。
//   4. 收件箱 = `<根>/.wao/inbox/`。`--inbox-dir DIR`（本模块的 inboxDir 选项）
//      显式覆盖，用法同 `--run-dir`；测试一律用它，绝不碰真实收件箱。
//
// 只读面（list/show 与 hygiene 提示）不建目录：目录不存在就是 0 条。
//
// 架构契约：application 层服务，文件系统与 git 调用全部可注入（deps.fs /
// deps.execGit / deps.projectLabel / deps.redactor / deps.now /
// deps.randomSuffix / deps.packageRoot）。默认实现用 node:fs、
// execFileSync("git") 与 src/secretRedaction.js。
//
// 条目一律这样发布：在目标目录里写满一个临时文件，再用硬链接落成正式文件
// （publishExclusive）。硬链接的创建是原子的、只在目标不存在时成功：正式文件
// 一出现就是完整内容，同名已存在则得到 EEXIST。submit 靠它避免同 id 覆盖，
// close 靠它保证"看到已处理"时那份已处理副本是完整的。
// 不 import src/commands/**、src/mcp/**、SDK、zod，不联网、不调用模型。

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { projectBucketLabel } from "../projectIdentity.js";
import { createSecretRedactor } from "../secretRedaction.js";

export const FEEDBACK_SCHEMA_VERSION = 1;
/** 正文（提交文件）字节上限：超过即拒，先看文件大小，不先整读再判。 */
export const FEEDBACK_BODY_MAX_BYTES = 32768;
/** 标题上限（按 code point 截，多字节安全）。 */
export const FEEDBACK_TITLE_MAX_CHARS = 120;
/** 处理说明上限（按 code point 计）。 */
export const FEEDBACK_NOTE_MAX_CHARS = 2000;
/** id 形状：fb_<YYYYMMDDTHHMMSSZ>_<6 位小写字母与数字>。 */
export const FEEDBACK_ID_RE = /^fb_[0-9]{8}T[0-9]{6}Z_[a-z0-9]{6}$/;
export const FEEDBACK_FILE_RE = /^fb_[0-9]{8}T[0-9]{6}Z_[a-z0-9]{6}\.json$/;
export const FEEDBACK_INBOX_DIR_SEGMENTS = Object.freeze([".wao", "inbox"]);
export const FEEDBACK_OPEN_DIRNAME = "open";
export const FEEDBACK_CLOSED_DIRNAME = "closed";
export const FEEDBACK_IDS_DIRNAME = "ids";
/** hygiene 提示遇到读不出时的闭集原因（消费者按 code 分支，不 parse 文案）。 */
export const FEEDBACK_INBOX_READ_FAILURE_REASONS = Object.freeze(["inbox-dir-unreadable", "entry-unreadable"]);

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const ID_SUFFIX_LEN = 6;
const ID_COLLISION_ATTEMPTS = 8;

/** 具名错误：code 是闭集（消费者按 code 分支，不 parse 文案）。 */
export class FeedbackError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "FeedbackError";
    this.code = code;
  }
}

/** WAO 代码所在检出的根（模块自身位置推出——不看 cwd，不看 WAO_INSTALL_ROOT）。 */
export function defaultPackageRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function defaultExecGit(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
}

function defaultRandomSuffix() {
  const bytes = randomBytes(ID_SUFFIX_LEN);
  let out = "";
  for (let i = 0; i < ID_SUFFIX_LEN; i += 1) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return out;
}

function defaultFs(io = {}) {
  return {
    existsSync: io.existsSync ?? existsSync,
    mkdirSync: io.mkdirSync ?? mkdirSync,
    readdirSync: io.readdirSync ?? readdirSync,
    readFileSync: io.readFileSync ?? readFileSync,
    statSync: io.statSync ?? statSync,
    writeFileSync: io.writeFileSync ?? writeFileSync,
    linkSync: io.linkSync ?? linkSync,
    unlinkSync: io.unlinkSync ?? unlinkSync,
  };
}

function withDeps(deps = {}) {
  return {
    fs: defaultFs(deps.fs),
    execGit: deps.execGit ?? defaultExecGit,
    projectLabel: deps.projectLabel ?? projectBucketLabel,
    redactor: deps.redactor ?? createSecretRedactor(),
    now: deps.now ?? (() => new Date()),
    randomSuffix: deps.randomSuffix ?? defaultRandomSuffix,
    packageRoot: typeof deps.packageRoot === "string" && deps.packageRoot.length > 0
      ? deps.packageRoot
      : defaultPackageRoot(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 根解析（不看 cwd）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * packageRoot 所在 Git 仓的主检出（`git worktree list --porcelain` 首条，git
 * 契约：首条恒为主检出，从任意工作树观察一致）；不在 Git 仓里 → null。
 */
function primaryCheckoutRoot(d) {
  let out;
  try {
    out = d.execGit(["worktree", "list", "--porcelain"], d.packageRoot);
  } catch {
    return null; // 不在 Git 仓（安装形态）或 git 不可用：如实回退 packageRoot
  }
  const line = String(out ?? "").split(/\r?\n/).find((l) => l.startsWith("worktree "));
  if (!line) return null;
  const p = line.slice("worktree ".length).trim();
  return p.length > 0 ? p : null;
}

/**
 * 收件箱根目录（`<根>/.wao/inbox`）。
 *
 * @param {{inboxDir?: string, packageRoot?: string, execGit?: Function, fs?: object}} [deps]
 *   inboxDir 显式覆盖（相对路径按进程 cwd 解析，与 --run-dir 同规则）。
 * @returns {string}
 */
export function resolveFeedbackInboxDir(deps = {}) {
  if (typeof deps.inboxDir === "string" && deps.inboxDir.length > 0) return resolve(deps.inboxDir);
  const d = withDeps(deps);
  const root = primaryCheckoutRoot(d) ?? d.packageRoot;
  return join(root, ...FEEDBACK_INBOX_DIR_SEGMENTS);
}

export function feedbackOpenDir(inboxDir) {
  return join(inboxDir, FEEDBACK_OPEN_DIRNAME);
}

export function feedbackClosedDir(inboxDir) {
  return join(inboxDir, FEEDBACK_CLOSED_DIRNAME);
}

export function feedbackIdsDir(inboxDir) {
  return join(inboxDir, FEEDBACK_IDS_DIRNAME);
}

// ─────────────────────────────────────────────────────────────────────────────
// 形状与校验
// ─────────────────────────────────────────────────────────────────────────────

export function isValidFeedbackId(id) {
  return typeof id === "string" && FEEDBACK_ID_RE.test(id);
}

/** 本次调用的收件箱：options.inboxDir（`--inbox-dir`）优先，其次 deps.inboxDir。 */
function inboxDirFor(options, deps, d) {
  const explicit = typeof options?.inboxDir === "string" && options.inboxDir.length > 0
    ? options.inboxDir
    : deps.inboxDir;
  return resolveFeedbackInboxDir({ ...deps, inboxDir: explicit, packageRoot: d.packageRoot });
}

/** show/close 的 id 门：形状不合一律具名拒绝（零读写——校验在任何路径拼接之前）。 */
export function assertValidFeedbackId(id) {
  if (isValidFeedbackId(id)) return id;
  throw new FeedbackError("invalid-id",
    `非法反馈 id: ${JSON.stringify(id ?? null)}（形状 fb_<YYYYMMDDTHHMMSSZ>_<6 位小写字母数字>）——拒绝，未读写任何文件`);
}

/** 解析一个条目文件的内容；JSON 坏或字段缺 → null（调用方计读不出，不当 0）。 */
function parseFeedbackEntry(raw) {
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  if (obj.schemaVersion !== FEEDBACK_SCHEMA_VERSION) return null;
  if (!isValidFeedbackId(obj.id)) return null;
  if (typeof obj.receivedAt !== "string" || typeof obj.title !== "string" || typeof obj.body !== "string") return null;
  if (obj.status !== "open" && obj.status !== "closed") return null;
  const s = obj.source;
  if (!s || typeof s !== "object" || Array.isArray(s)) return null;
  if (!("projectLabel" in s) || !("waoCommit" in s)) return null;
  if (s.projectLabel !== null && typeof s.projectLabel !== "string") return null;
  if (s.waoCommit !== null && typeof s.waoCommit !== "string") return null;
  if (obj.status === "closed" && (typeof obj.closedAt !== "string" || typeof obj.note !== "string")) return null;
  return obj;
}

/** 读一个条目文件：missing（无此文件）/ unreadable（读或形状坏）/ ok。 */
function readEntryFile(path, d) {
  let raw;
  try {
    raw = d.fs.readFileSync(path, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return { state: "missing" };
    return { state: "unreadable" };
  }
  const entry = parseFeedbackEntry(raw);
  return entry === null ? { state: "unreadable" } : { state: "ok", entry };
}

/** cwd 的 Git 顶层 → projectLabel；cwd 不在 Git 仓里或认不出项目 → null。 */
function projectLabelForCwd(cwd, d) {
  try {
    const top = String(d.execGit(["rev-parse", "--show-toplevel"], cwd) ?? "").trim();
    if (top.length === 0) return null;
    return d.projectLabel(top) ?? null;
  } catch {
    return null;
  }
}

/** packageRoot 的 HEAD 短哈希（WAO 自己的提交，不是 cwd 那个仓的）；取不到 null。 */
function waoCommitFor(d) {
  try {
    const out = String(d.execGit(["rev-parse", "--short", "HEAD"], d.packageRoot) ?? "").trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function truncateCodePoints(value, max) {
  const points = [...value];
  return points.length <= max ? value : points.slice(0, max).join("");
}

function deriveTitle(body, explicitTitle) {
  if (typeof explicitTitle === "string" && explicitTitle.trim().length > 0) return explicitTitle.trim();
  const heading = body.match(/^#{1,6}[ \t]+(.+)$/m);
  if (heading) return heading[1].trim();
  const line = body.split(/\r?\n/).find((l) => l.trim().length > 0);
  return line ? line.trim() : "";
}

function formatIdStamp(date) {
  return `${date.toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;
}

function summarize(entry) {
  return { id: entry.id, receivedAt: entry.receivedAt, title: entry.title, source: entry.source };
}

function byReceivedAtDesc(a, b) {
  if (a.receivedAt !== b.receivedAt) return a.receivedAt < b.receivedAt ? 1 : -1;
  if (a.id !== b.id) return a.id < b.id ? 1 : -1;
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// submit
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 收一条反馈：校验 → 脱敏 → 在 `open/` 同目录写临时文件 → 改名为 `<id>.json`。
 *
 * @param {{file?: string, title?: string, cwd?: string, inboxDir?: string}} options
 * @param {object} [deps] 见文件头。
 * @returns {{id: string, receivedAt: string, title: string, status: "open",
 *            source: {projectLabel: string|null, waoCommit: string|null},
 *            relativePath: string, path: string}}
 */
export function submitFeedback(options = {}, deps = {}) {
  const d = withDeps(deps);
  const { file } = options;
  if (typeof file !== "string" || file.length === 0) {
    throw new FeedbackError("file-required", "feedback submit 需要 --file <md>（反馈正文的 Markdown 文件）");
  }
  const inboxDir = inboxDirFor(options, deps, d);
  const openDir = feedbackOpenDir(inboxDir);

  // 先看大小，再决定读不读——超限的文件绝不整读。
  let size;
  try {
    const st = d.fs.statSync(file);
    if (!st.isFile()) throw new FeedbackError("file-not-regular", `反馈文件不是一个普通文件: ${file}`);
    size = st.size;
  } catch (err) {
    if (err instanceof FeedbackError) throw err;
    throw new FeedbackError("file-unreadable", `反馈文件读不出: ${file}`);
  }
  if (size > FEEDBACK_BODY_MAX_BYTES) {
    throw new FeedbackError("body-too-large",
      `反馈正文 ${size} 字节，超过上限 ${FEEDBACK_BODY_MAX_BYTES} 字节——先精简再提交（上限含全部多字节字符）`);
  }

  const buf = d.fs.readFileSync(file);
  // 文件在 stat 之后可能又变大：按实际读到的字节再判一次上限。
  if (buf.length > FEEDBACK_BODY_MAX_BYTES) {
    throw new FeedbackError("body-too-large",
      `反馈正文 ${buf.length} 字节，超过上限 ${FEEDBACK_BODY_MAX_BYTES} 字节——先精简再提交（上限含全部多字节字符）`);
  }
  let body;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    throw new FeedbackError("body-invalid-utf8", "反馈正文不是合法 UTF-8——拒绝写入（不做有损替换）");
  }
  if (body.includes("\u0000")) {
    throw new FeedbackError("body-has-nul", "反馈正文含 NUL 字节——拒绝写入");
  }
  if (body.trim().length === 0) {
    throw new FeedbackError("body-empty", "反馈正文为空——写明复现、预期与实际后再提交");
  }

  // 先脱敏、后截断：截断若在前，横跨截断点的已登记凭据只剩前缀，整值替换就认不出它。
  const title = truncateCodePoints(d.redactor.redactString(deriveTitle(body, options.title)), FEEDBACK_TITLE_MAX_CHARS);
  const redactedBody = d.redactor.redactString(body);
  const now = d.now();
  const receivedAt = now.toISOString();
  const stamp = formatIdStamp(now);
  const cwd = typeof options.cwd === "string" && options.cwd.length > 0 ? options.cwd : process.cwd();
  const source = {
    projectLabel: projectLabelForCwd(cwd, d),
    waoCommit: waoCommitFor(d),
  };

  d.fs.mkdirSync(openDir, { recursive: true });
  const idsDir = feedbackIdsDir(inboxDir);
  d.fs.mkdirSync(idsDir, { recursive: true });
  for (let attempt = 0; attempt < ID_COLLISION_ATTEMPTS; attempt += 1) {
    const id = `fb_${stamp}_${d.randomSuffix()}`;
    // 先在 ids/ 里独占登记（"不存在才创建"，永不删除）：分出去过的 id 不会再分
    // 第二次。只查 open/、closed/ 不够——查完到发布之间，同名旧条目可能刚被
    // close 搬走，新条目随后会被 list 按 id 去重藏起，再 close 还会删掉它。
    if (!reserveFeedbackId(d, idsDir, id)) continue;
    const entry = {
      schemaVersion: FEEDBACK_SCHEMA_VERSION,
      id,
      receivedAt,
      title,
      body: redactedBody,
      source,
      status: "open",
    };
    const path = join(openDir, `${id}.json`);
    // 同 id 已在 open/（并发提交撞了同一个后缀）：换后缀再试，绝不覆盖。
    if (publishExclusive(d, openDir, path, `${JSON.stringify(entry, null, 2)}\n`)) {
      return { ...entry, relativePath: `${FEEDBACK_OPEN_DIRNAME}/${id}.json`, path };
    }
  }
  throw new FeedbackError("id-collision", `同一秒内生成不出未占用的反馈 id（已试 ${ID_COLLISION_ATTEMPTS} 次）——稍后重试`);
}

// ─────────────────────────────────────────────────────────────────────────────
// list / show / close
// ─────────────────────────────────────────────────────────────────────────────

function readEntryDir(dir, d) {
  let names;
  try {
    names = d.fs.readdirSync(dir);
  } catch (err) {
    if (err?.code === "ENOENT") return { entries: [], unreadable: 0 };
    throw new FeedbackError("inbox-unreadable", `收件箱读不出: ${dir}`);
  }
  const entries = [];
  let unreadable = 0;
  for (const name of names) {
    if (!FEEDBACK_FILE_RE.test(name)) continue; // 临时文件与杂物不计
    const read = readEntryFile(join(dir, name), d);
    if (read.state === "ok") entries.push(read.entry);
    else unreadable += 1;
  }
  return { entries, unreadable };
}

/**
 * 列出条目：`{ open, closed?, unreadable }`。closed 只在 all=true 时出现。
 * 同一 id 同时存在于两个目录（close 中途失败）时按 id 去重，以 closed 为准。
 * 损坏条目只计进 unreadable——其余条目照常列出，不当作 0，不崩。
 */
export function listFeedback(options = {}, deps = {}) {
  const d = withDeps(deps);
  const inboxDir = inboxDirFor(options, deps, d);
  const closedRead = readEntryDir(feedbackClosedDir(inboxDir), d);
  const openRead = readEntryDir(feedbackOpenDir(inboxDir), d);
  const closedIds = new Set(closedRead.entries.map((entry) => entry.id));
  const open = openRead.entries
    .filter((entry) => !closedIds.has(entry.id))
    .map(summarize)
    .sort(byReceivedAtDesc);
  const result = { open };
  if (options.all) result.closed = closedRead.entries.map(summarize).sort(byReceivedAtDesc);
  result.unreadable = closedRead.unreadable + openRead.unreadable;
  return result;
}

/** 打印全文：先找未处理，再找已处理；都没有 → 具名错误。 */
export function showFeedback(id, options = {}, deps = {}) {
  assertValidFeedbackId(id);
  const d = withDeps(deps);
  const inboxDir = inboxDirFor(options, deps, d);
  const openRead = readEntryFile(join(feedbackOpenDir(inboxDir), `${id}.json`), d);
  if (openRead.state === "ok") return openRead.entry;
  const closedRead = readEntryFile(join(feedbackClosedDir(inboxDir), `${id}.json`), d);
  if (closedRead.state === "ok") return closedRead.entry;
  if (openRead.state === "unreadable" || closedRead.state === "unreadable") {
    throw new FeedbackError("feedback-unreadable", `反馈条目损坏，读不出全文: ${id}`);
  }
  throw new FeedbackError("feedback-not-found", `没有这条反馈: ${id}`);
}

/**
 * 标为已处理：读 open → 在 closed 同目录写临时文件 → 以“目标不存在才创建”
 * 落成 closed/<id>.json → 成功后删 open/<id>.json。同一 id 并发关闭只有一个
 * 成功，其余得到“已处理”；重复 close 不改写已有的处理说明。closed 已落而
 * open 未删的残留，由下一次 close 清掉（list 侧同时按 id 以 closed 为准）。
 */
export function closeFeedback(id, options = {}, deps = {}) {
  assertValidFeedbackId(id);
  const rawNote = typeof options.note === "string" ? options.note.trim() : "";
  if (rawNote.length === 0) {
    throw new FeedbackError("note-required", "feedback close 需要 --note <text>（写明这条反馈怎么处理的）");
  }
  if ([...rawNote].length > FEEDBACK_NOTE_MAX_CHARS) {
    throw new FeedbackError("note-too-long", `处理说明 ${[...rawNote].length} 个字符，超过上限 ${FEEDBACK_NOTE_MAX_CHARS} 个字符`);
  }
  const d = withDeps(deps);
  const inboxDir = inboxDirFor(options, deps, d);
  const openPath = join(feedbackOpenDir(inboxDir), `${id}.json`);
  const closedDir = feedbackClosedDir(inboxDir);
  const closedPath = join(closedDir, `${id}.json`);

  const openRead = readEntryFile(openPath, d);
  if (openRead.state !== "ok") {
    if (d.fs.existsSync(closedPath)) {
      // 已处理副本是硬链接发布的完整权威；open 若是损坏的残留，一并清掉。
      if (openRead.state === "unreadable") removeQuietly(d, openPath);
      throw new FeedbackError("already-closed", `这条反馈已处理: ${id}（已有的处理说明不改写）`);
    }
    if (openRead.state === "unreadable") {
      throw new FeedbackError("feedback-unreadable", `反馈条目损坏，无法收口: ${id}`);
    }
    throw new FeedbackError("feedback-not-open", `没有这条未处理反馈: ${id}`);
  }

  const closedEntry = {
    schemaVersion: FEEDBACK_SCHEMA_VERSION,
    id: openRead.entry.id,
    receivedAt: openRead.entry.receivedAt,
    title: openRead.entry.title,
    body: openRead.entry.body,
    source: openRead.entry.source,
    status: "closed",
    closedAt: d.now().toISOString(),
    note: d.redactor.redactString(rawNote),
  };
  d.fs.mkdirSync(closedDir, { recursive: true });
  // 同一 id 并发关闭只有一个发布成功。EEXIST 时那份已处理副本是硬链接发布的、
  // 内容完整，删掉 open 不会丢反馈；顺手清掉崩溃窗里残留的 open 副本。
  if (!publishExclusive(d, closedDir, closedPath, `${JSON.stringify(closedEntry, null, 2)}\n`)) {
    removeQuietly(d, openPath);
    throw new FeedbackError("already-closed", `这条反馈已处理: ${id}（已有的处理说明不改写）`);
  }
  removeQuietly(d, openPath);
  return closedEntry;
}

/**
 * 只在目标不存在时发布一个完整文件：在 dir（与目标同目录）写满临时文件，再用
 * 硬链接落成 target。返回 true=已发布，false=target 已存在（EEXIST）；其它错误
 * 照抛。临时文件总会清掉，list 也只认 fb_*.json，不会把它当条目。
 */
function publishExclusive(d, dir, target, content) {
  const tmp = join(dir, `.wao-tmp-fb-${process.pid}-${randomBytes(6).toString("hex")}`);
  try {
    // 写入也在 try 里：写到一半失败（如磁盘满）留下的临时文件同样由 finally 清掉。
    d.fs.writeFileSync(tmp, content, "utf8");
    d.fs.linkSync(tmp, target);
    return true;
  } catch (err) {
    if (err?.code === "EEXIST") return false;
    throw err;
  } finally {
    removeQuietly(d, tmp);
  }
}

/** 在 ids/ 里以"不存在才创建"登记一个 id。true=登记成功；false=这个 id 分出去过。 */
function reserveFeedbackId(d, idsDir, id) {
  try {
    d.fs.writeFileSync(join(idsDir, id), "", { flag: "wx" });
    return true;
  } catch (err) {
    if (err?.code === "EEXIST") return false;
    throw err;
  }
}

function removeQuietly(d, path) {
  try {
    d.fs.unlinkSync(path);
  } catch {
    /* 已不在（或短暂被占用）：残留由下一次 close 清理 */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// hygiene 提示（只打印计数，不打印标题与正文；任何异常由调用方吞掉）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * hygiene 在 W1–W5 之后打印的提示行（0 条未处理且无读不出 → 空数组）。
 * 读不出时的原因取自闭集 FEEDBACK_INBOX_READ_FAILURE_REASONS。
 *
 * @param {{inboxDir?: string}} [options]
 * @param {object} [deps]
 * @returns {string[]}
 */
export function feedbackInboxHintLines(options = {}, deps = {}) {
  const inboxDir = resolveFeedbackInboxDir({ ...deps, ...options });
  let summary;
  try {
    summary = listFeedback({ inboxDir }, deps);
  } catch (err) {
    if (err instanceof FeedbackError && err.code === "inbox-unreadable") {
      return ["反馈收件箱读不出（inbox-dir-unreadable）— 处理: wao feedback list 看能否恢复"];
    }
    throw err;
  }
  const lines = [];
  if (summary.open.length > 0) {
    lines.push(`反馈收件箱：${summary.open.length} 条未处理 — 查看: wao feedback list（收口: wao feedback close <id> --note <text>）`);
  }
  if (summary.unreadable > 0) {
    lines.push(`反馈收件箱读不出（entry-unreadable：${summary.unreadable} 条）— 查看: wao feedback list`);
  }
  return lines;
}
