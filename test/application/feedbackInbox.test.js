// test/application/feedbackInbox.test.js
//
// 本机反馈收件箱（src/application/feedbackInbox.js + src/commands/feedback.js +
// scripts/hygiene-cli.mjs 的提示行）行为钉。资源归组：git（用临时 Git 仓验证
// cwd→Git 顶层→projectLabel 的链路）。
//
// 纪律：所有收件箱都是 os.tmpdir() 下的临时目录，一律走 inboxDir（--inbox-dir）
// 覆盖——绝不读、绝不写真实 .wao/inbox/。反馈正文一律虚构，不含任何真实宿主名。
// 只读面（list/show/hygiene 提示）必须不建目录。

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FEEDBACK_BODY_MAX_BYTES,
  FEEDBACK_INBOX_READ_FAILURE_REASONS,
  closeFeedback,
  feedbackInboxHintLines,
  listFeedback,
  resolveFeedbackInboxDir,
  showFeedback,
  submitFeedback,
} from "../../src/application/feedbackInbox.js";
import { COMMAND_NAMES, HELP_TEXT } from "../../src/cliHelp.js";
import { createSecretRedactor } from "../../src/secretRedaction.js";
import { rmrfRetry } from "../_rmrfHelper.mjs";

const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..");
const ID_SHAPE = /^fb_\d{8}T\d{6}Z_[a-z0-9]{6}$/;

function makeTemp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Windows 路径归一（仅用于比较注入参数，避免大小写/分隔符漂移）。 */
function norm(p) {
  return String(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function writeBody(dir, name, content) {
  const file = join(dir, name);
  writeFileSync(file, content);
  return file;
}

function entryPath(inboxDir, bucket, id) {
  return join(inboxDir, bucket, `${id}.json`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function initGitRepo(dir) {
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "fixture"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "readme.txt"), "fixture\n");
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: dir, stdio: "ignore" });
}

/** 每个用例一个临时家目录；收件箱是它下面的子目录（绝不是真实收件箱）。 */
function withTempHome(prefix, fn) {
  const home = makeTemp(prefix);
  try {
    return fn(home, join(home, "inbox"));
  } finally {
    rmrfRetry(home);
  }
}

/** 可注入的 git 替身：记录每次调用的 (args, cwd)。 */
function gitStub({ worktrees = [], toplevel = null, shortHead = null } = {}) {
  const calls = [];
  const fn = (args, cwd) => {
    calls.push({ args: args.join(" "), cwd });
    if (args[0] === "worktree") {
      if (worktrees.length === 0) throw new Error("not a git repository");
      return worktrees.map((w) => `worktree ${w}\nHEAD 0000000\nbranch refs/heads/main\n\n`).join("");
    }
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      if (toplevel === null) throw new Error("not a git repository");
      return `${toplevel}\n`;
    }
    if (args[0] === "rev-parse" && args[1] === "--short") {
      if (shortHead === null) throw new Error("no HEAD");
      return `${shortHead}\n`;
    }
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  };
  fn.calls = calls;
  return fn;
}

function runCli(args, cwd) {
  return spawnSync(process.execPath, [join(REPO_ROOT, "src", "cli.js"), ...args], {
    cwd,
    encoding: "utf8",
    timeout: 30000,
    env: { ...process.env, WAO_SKIP_VERSION_GUARD: "1" },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 根解析：packageRoot 的检出 → 主检出；不在 Git 仓 → packageRoot；cwd 不参与
// ─────────────────────────────────────────────────────────────────────────────

test("根解析：packageRoot 是主检出、是关联工作树、不在 Git 仓三种形态", () => {
  const primary = "Z:/fixtures/wao-primary";
  const linked = "Z:/fixtures/wao-primary/.dev/wt/batch-x";
  const primaryInbox = join(primary, ".wao", "inbox");

  const asPrimary = resolveFeedbackInboxDir({
    packageRoot: primary,
    execGit: gitStub({ worktrees: [primary, linked] }),
  });
  assert.equal(asPrimary, primaryInbox, "主检出 → 主检出的收件箱");

  const asLinked = resolveFeedbackInboxDir({
    packageRoot: linked,
    execGit: gitStub({ worktrees: [primary, linked] }),
  });
  assert.equal(asLinked, primaryInbox, "关联工作树 → 仍是主检出的收件箱（不会看到假空的本地收件箱）");

  const asInstall = resolveFeedbackInboxDir({
    packageRoot: "Z:/install-form/wao",
    execGit: gitStub({}),
  });
  assert.equal(asInstall, join("Z:/install-form/wao", ".wao", "inbox"), "不在 Git 仓（安装形态）→ packageRoot");

  // cwd 不参与解析；git 一律以 packageRoot 为观察点询问。
  const git = gitStub({ worktrees: [primary, linked] });
  const withCwd = resolveFeedbackInboxDir({ packageRoot: linked, cwd: "Z:/somewhere/else", execGit: git });
  assert.equal(withCwd, primaryInbox, "cwd 不进解析式");
  assert.deepEqual(git.calls, [{ args: "worktree list --porcelain", cwd: linked }], "git 在 packageRoot 上问，而不是 cwd");

  // 显式 --inbox-dir 覆盖一切。
  const explicit = join(tmpdir(), "wao-fb-explicit-inbox");
  assert.equal(
    resolveFeedbackInboxDir({ packageRoot: primary, execGit: gitStub({ worktrees: [primary] }), inboxDir: explicit }),
    explicit,
    "显式覆盖：原样解析给出的目录",
  );
});

test("submit：条目落在 --inbox-dir，不碰解析出的位置，也不碰真实收件箱", () =>
  withTempHome("wao-fb-submit-", (home, inboxDir) => {
    const fakePrimary = join(home, "fake-primary");
    const file = writeBody(home, "body.md", "# 虚构反馈\n\n正文：虚构宿主项目里的一处别扭。\n");
    const entry = submitFeedback(
      { file, cwd: home, inboxDir },
      { packageRoot: fakePrimary, execGit: gitStub({ worktrees: [fakePrimary] }) },
    );
    assert.match(entry.id, ID_SHAPE, "id 形状 fb_<UTC 时间戳>_<6 位小写字母数字>");
    assert.equal(entry.relativePath, `open/${entry.id}.json`);
    assert.ok(existsSync(entryPath(inboxDir, "open", entry.id)), "条目落在显式收件箱");
    assert.ok(!existsSync(join(fakePrimary, ".wao")), "解析出的位置不被创建/写入");
    assert.deepEqual([...FEEDBACK_INBOX_READ_FAILURE_REASONS].sort(), ["entry-unreadable", "inbox-dir-unreadable"]);
  }));

// ─────────────────────────────────────────────────────────────────────────────
// 跨项目入口与来源事实
// ─────────────────────────────────────────────────────────────────────────────

test("跨项目：cwd 是另一个 Git 仓（或其子目录）时，标签取 cwd 的 Git 顶层；非 Git cwd → null", () =>
  withTempHome("wao-fb-cross-", (home, inboxDir) => {
    const hostRepo = join(home, "fictional-host-project");
    mkdirSync(join(hostRepo, "src", "deep"), { recursive: true });
    initGitRepo(hostRepo);
    const file = writeBody(home, "body.md", "# 跨项目反馈\n\n最小复现：虚构命令 + 虚构输入。\n");

    const seen = [];
    const deps = {
      packageRoot: join(home, "fake-wao-checkout"),
      execGit: (args, cwd) => {
        if (args[0] === "worktree") throw new Error("not in a git repo");
        if (args[1] === "--show-toplevel") return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
        if (args[1] === "--short") return "0badc0d\n";
        throw new Error(`unexpected git call: ${args.join(" ")}`);
      },
      projectLabel: (top) => {
        seen.push(norm(top));
        return `label-${basename(top)}`;
      },
    };
    const fromRoot = submitFeedback({ file, cwd: hostRepo, inboxDir }, deps);
    const fromSubdir = submitFeedback({ file, cwd: join(hostRepo, "src", "deep"), inboxDir }, deps);

    assert.equal(fromRoot.source.projectLabel, `label-${basename(hostRepo)}`);
    assert.equal(fromSubdir.source.projectLabel, fromRoot.source.projectLabel, "子目录提交与根目录提交得到同一个标签");
    assert.deepEqual(seen, [norm(hostRepo), norm(hostRepo)], "projectLabel 收到的是 cwd 的 Git 顶层（两次同一个）");

    const notGit = submitFeedback({ file, cwd: join(home, "plain-dir"), inboxDir });
    assert.equal(notGit.source.projectLabel, null, "非 Git cwd → 标签 null，照样受理");
    assert.ok(existsSync(entryPath(inboxDir, "open", notGit.id)), "非 Git cwd 的条目照常落盘");
  }));

test("来源 waoCommit 取 WAO 检出的 HEAD，不是 cwd 那个仓的", () =>
  withTempHome("wao-fb-source-", (home, inboxDir) => {
    const file = writeBody(home, "body.md", "# 来源钉\n\n虚构正文。\n");
    const calls = [];
    const entry = submitFeedback(
      { file, cwd: "Z:/fictional/host-project/sub", inboxDir },
      {
        packageRoot: "Z:/fictional/wao-checkout",
        execGit: (args, cwd) => {
          calls.push({ args: args.join(" "), cwd: norm(cwd) });
          if (args[0] === "worktree") throw new Error("not a repo");
          if (args[1] === "--show-toplevel") return "Z:/fictional/host-project\n";
          if (args[1] === "--short") return "abc1234\n";
          throw new Error("unexpected");
        },
        projectLabel: () => "label-fictional",
      },
    );
    assert.equal(entry.source.waoCommit, "abc1234");
    const headCall = calls.find((c) => c.args === "rev-parse --short HEAD");
    assert.ok(headCall, "HEAD 短哈希被读取");
    assert.equal(headCall.cwd, norm("Z:/fictional/wao-checkout"), "HEAD 从 WAO 检出读，不从 cwd 那个仓读");
    assert.equal(entry.source.projectLabel, "label-fictional");
  }));

test("来源：真实 Git 仓下 waoCommit 等于 WAO 检出 HEAD，且不等于 cwd 那个仓的 HEAD", () =>
  withTempHome("wao-fb-realhead-", (home, inboxDir) => {
    const hostRepo = join(home, "fictional-host-project");
    mkdirSync(hostRepo, { recursive: true });
    initGitRepo(hostRepo);
    const file = writeBody(home, "body.md", "# 真实 HEAD\n\n虚构正文。\n");
    const waoHead = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
    const hostHead = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: hostRepo, encoding: "utf8" }).trim();
    assert.notEqual(waoHead, hostHead, "夹具自检：两个仓的 HEAD 不同，才钉得住'取哪一个'");
    const entry = submitFeedback({ file, cwd: hostRepo, inboxDir });
    assert.equal(entry.source.waoCommit, waoHead, "记的是 WAO 检出的提交");
  }));

// ─────────────────────────────────────────────────────────────────────────────
// 正文规则：32768 字节上限、UTF-8、NUL
// ─────────────────────────────────────────────────────────────────────────────

test("正文上限：32768 字节（含多字节字符）收，32769 拒，且拒时不整读文件", () =>
  withTempHome("wao-fb-size-", (home, inboxDir) => {
    // 32768 = 32765 个 ASCII + 1 个 3 字节汉字。
    const atLimit = `${"a".repeat(FEEDBACK_BODY_MAX_BYTES - 3)}好`;
    const overLimit = `${"a".repeat(FEEDBACK_BODY_MAX_BYTES - 2)}好`;
    const okFile = writeBody(home, "at-limit.md", atLimit);
    const overFile = writeBody(home, "over-limit.md", overLimit);
    assert.equal(statSync(okFile).size, FEEDBACK_BODY_MAX_BYTES);
    assert.equal(statSync(overFile).size, FEEDBACK_BODY_MAX_BYTES + 1);

    const entry = submitFeedback({ file: okFile, inboxDir });
    assert.equal(readJson(entryPath(inboxDir, "open", entry.id)).body, atLimit, "上限整好收下（多字节安全）");

    assert.throws(() => submitFeedback({ file: overFile, inboxDir }), (err) => {
      assert.match(err.message, /32768/, "拒绝文案写明上限");
      assert.match(err.message, /32769/, "拒绝文案写明实际字节数");
      return true;
    });

    // 未整读证明：读了就抛的 fs 缝下，超限文件仍报上限错（先 stat 后读）。
    const spyFs = {
      statSync: (p) => statSync(p),
      readFileSync: () => {
        throw new Error("readFileSync must not run for an over-limit file");
      },
    };
    assert.throws(() => submitFeedback({ file: overFile, inboxDir }, { fs: spyFs }), /32768/);

    // 文件在 stat 之后变大：按实际读到的字节再判一次上限。
    const growingFs = {
      statSync: () => ({ isFile: () => true, size: 10 }),
      readFileSync: () => Buffer.alloc(FEEDBACK_BODY_MAX_BYTES + 1, 0x61),
    };
    assert.throws(() => submitFeedback({ file: okFile, inboxDir }, { fs: growingFs }), /32768/);
  }));

test("正文拒收：非法 UTF-8 与 NUL 字节", () =>
  withTempHome("wao-fb-encoding-", (home, inboxDir) => {
    const badUtf8 = join(home, "bad-utf8.md");
    writeFileSync(badUtf8, Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]));
    assert.throws(() => submitFeedback({ file: badUtf8, inboxDir }), /UTF-8/);

    const withNul = writeBody(home, "nul.md", "前\u0000后\n");
    assert.throws(() => submitFeedback({ file: withNul, inboxDir }), /NUL/);

    assert.ok(!existsSync(join(inboxDir, "open")), "两处拒收都不落盘、不建目录");

    const blank = writeBody(home, "blank.md", "  \n\n\t\n");
    assert.throws(() => submitFeedback({ file: blank, inboxDir, title: "只有标题" }), /为空/);
    assert.ok(!existsSync(join(inboxDir, "open")), "空正文不落盘、不建目录");
  }));

// ─────────────────────────────────────────────────────────────────────────────
// 标题：回退链与 120 code point 截断
// ─────────────────────────────────────────────────────────────────────────────

test("标题：--title > 第一个 Markdown 标题 > 第一行非空文字，截到 120 个 code point", () =>
  withTempHome("wao-fb-title-", (home, inboxDir) => {
    const fallbackBody = writeBody(home, "fallback.md", "\n\n  第一行非空文字  \n第二行\n");
    const fromLine = submitFeedback({ file: fallbackBody, inboxDir });
    assert.equal(readJson(entryPath(inboxDir, "open", fromLine.id)).title, "第一行非空文字");

    const headingBody = writeBody(home, "heading.md", "正文开头\n\n### 三级标题\n\n更多正文\n");
    const fromHeading = submitFeedback({ file: headingBody, inboxDir });
    assert.equal(readJson(entryPath(inboxDir, "open", fromHeading.id)).title, "三级标题");

    const explicit = submitFeedback({ file: headingBody, title: "  显式标题  ", inboxDir });
    assert.equal(readJson(entryPath(inboxDir, "open", explicit.id)).title, "显式标题", "--title 覆盖标题回退链");

    const longTitle = "好".repeat(200);
    const truncated = submitFeedback({ file: fallbackBody, title: longTitle, inboxDir });
    const stored = readJson(entryPath(inboxDir, "open", truncated.id)).title;
    assert.equal([...stored].length, 120, "按 code point 截到 120（多字节安全）");
    assert.equal(stored, "好".repeat(120));

    const longLine = submitFeedback({ file: writeBody(home, "long-line.md", `${"文".repeat(150)}\n`), inboxDir });
    assert.equal(readJson(entryPath(inboxDir, "open", longLine.id)).title, "文".repeat(120), "第一行文字同样截断");
  }));

// ─────────────────────────────────────────────────────────────────────────────
// id 校验：形状不合一律具名拒绝，零读写
// ─────────────────────────────────────────────────────────────────────────────

test("id 校验：非法形状（.. / 绝对路径 / 含分隔符 / 形状不对）具名拒绝且零读写", () =>
  withTempHome("wao-fb-id-", (home, inboxDir) => {
    const badIds = [
      "..",
      "../x",
      ".",
      "/absolute/path",
      "C:/absolute/path",
      "fb_20260102T030405Z_abc123/../x",
      "fb_20260102T030405Z_abc123\\x",
      "fb_20260102T030405Z_abc12",
      "fb_20260102T030405Z_abc1234",
      "fb_20260102T030405Z_ABC123",
      "fb_20260102T030405Z_abc-12",
      "fb_20260102T030405Z_abc123.json",
      "fb_20260102T030405Z_abc123 ",
      "a/b",
      "",
      null,
      undefined,
      42,
    ];
    // 全函数抛错的 fs 缝：任何读写都会炸——具名 id 错必须先于一切 fs 调用。
    const throwingFs = Object.fromEntries(
      ["existsSync", "mkdirSync", "readdirSync", "readFileSync", "statSync", "writeFileSync", "linkSync", "unlinkSync"]
        .map((name) => [name, () => {
          throw new Error(`fs.${name} must not run for an invalid id`);
        }]),
    );
    for (const id of badIds) {
      assert.throws(() => showFeedback(id, { inboxDir }), /非法反馈 id/, `show 拒 ${JSON.stringify(id)}`);
      assert.throws(() => closeFeedback(id, { note: "虚构处理说明", inboxDir }), /非法反馈 id/, `close 拒 ${JSON.stringify(id)}`);
      assert.throws(() => showFeedback(id, { inboxDir }, { fs: throwingFs }), /非法反馈 id/, `show 零读写 ${JSON.stringify(id)}`);
      assert.throws(() => closeFeedback(id, { note: "虚构处理说明", inboxDir }, { fs: throwingFs }), /非法反馈 id/, `close 零读写 ${JSON.stringify(id)}`);
    }
    assert.ok(!existsSync(inboxDir), "非法 id 全程不建目录（零读写）");
  }));

// ─────────────────────────────────────────────────────────────────────────────
// 并发与崩溃窗
// ─────────────────────────────────────────────────────────────────────────────

test("并发：同一秒两次 submit 得到两个不同 id；同一 id 两次 close 一个成功一个'已处理'", () =>
  withTempHome("wao-fb-concurrent-", (home, inboxDir) => {
    const file = writeBody(home, "body.md", "# 并发虚构反馈\n\n正文。\n");
    const fixedNow = new Date("2026-01-02T03:04:05.678Z");
    const suffixes = ["aaaaaa", "bbbbbb", "cccccc"];
    let n = 0;
    const deps = { now: () => fixedNow, randomSuffix: () => suffixes[Math.min(n++, suffixes.length - 1)] };
    const first = submitFeedback({ file, inboxDir }, deps);
    const second = submitFeedback({ file, inboxDir }, deps);
    assert.equal(first.id, "fb_20260102T030405Z_aaaaaa", "同一 UTC 秒的时间戳段");
    assert.equal(second.id, "fb_20260102T030405Z_bbbbbb");
    assert.notEqual(first.id, second.id, "同一秒内的两个 submit 不撞 id");
    assert.ok(existsSync(entryPath(inboxDir, "open", first.id)) && existsSync(entryPath(inboxDir, "open", second.id)));
    assert.equal(listFeedback({ inboxDir }).open.length, 2);

    const closed = closeFeedback(first.id, { note: "第一条处理说明（虚构）", inboxDir }, deps);
    assert.equal(closed.status, "closed");
    assert.equal(closed.closedAt, fixedNow.toISOString());
    assert.throws(() => closeFeedback(first.id, { note: "第二条不该写入", inboxDir }, deps),
      /已处理/, "重复 close 报'已处理'");
    assert.equal(readJson(entryPath(inboxDir, "closed", first.id)).note, "第一条处理说明（虚构）", "已有的处理说明不被改写");
    assert.equal(listFeedback({ inboxDir }).open.length, 1, "已处理的条目不再算未处理");
  }));

test("submit 撞 id：同名条目已在 open/ 或 closed/ 时换后缀重试，不覆盖、不被去重藏起", () =>
  withTempHome("wao-fb-collision-", (home, inboxDir) => {
    const file = writeBody(home, "body.md", "# 撞 id 虚构反馈\n\n正文。\n");
    const fixedNow = new Date("2026-01-02T03:04:05.678Z");
    const seq = (...suffixes) => {
      let i = 0;
      return { now: () => fixedNow, randomSuffix: () => suffixes[Math.min(i++, suffixes.length - 1)] };
    };
    const first = submitFeedback({ file, inboxDir }, seq("aaaaaa"));
    const firstRaw = readFileSync(entryPath(inboxDir, "open", first.id), "utf8");
    // 第二次提交的第一个候选与 open/ 里的撞上：必须换后缀，原条目一字不动。
    const second = submitFeedback({ file, inboxDir }, seq("aaaaaa", "bbbbbb"));
    assert.equal(second.id, "fb_20260102T030405Z_bbbbbb");
    assert.equal(readFileSync(entryPath(inboxDir, "open", first.id), "utf8"), firstRaw, "已有条目不被覆盖");
    // 已处理的同名 id 也算占用。
    closeFeedback(second.id, { note: "虚构处理", inboxDir });
    const third = submitFeedback({ file, inboxDir }, seq("bbbbbb", "cccccc"));
    assert.equal(third.id, "fb_20260102T030405Z_cccccc");
    assert.deepEqual(listFeedback({ inboxDir }).open.map((e) => e.id).sort(), [first.id, third.id].sort(),
      "新条目没有被已处理的同名条目藏起来");
  }));

test("id 永不复用：同名旧条目无论还在不在 open/、closed/，分出去过的 id 都换后缀", () =>
  withTempHome("wao-fb-id-reuse-", (home, inboxDir) => {
    const file = writeBody(home, "body.md", "# 复用虚构反馈\n\n正文。\n");
    const fixedNow = new Date("2026-01-02T03:04:05.678Z");
    const seq = (...suffixes) => {
      let i = 0;
      return { now: () => fixedNow, randomSuffix: () => suffixes[Math.min(i++, suffixes.length - 1)] };
    };
    const old = submitFeedback({ file, inboxDir }, seq("aaaaaa"));
    // 复现会审给出的交错：同名旧条目恰好在查重与发布之间被搬走，open/ 与 closed/
    // 都看不到它。登记表里仍有这个 id，新提交必须换后缀。
    unlinkSync(entryPath(inboxDir, "open", old.id));
    const fresh = submitFeedback({ file, inboxDir }, seq("aaaaaa", "bbbbbb"));
    assert.equal(fresh.id, "fb_20260102T030405Z_bbbbbb");
    assert.ok(existsSync(join(inboxDir, "ids", old.id)) && existsSync(join(inboxDir, "ids", fresh.id)), "两个 id 都已登记");
    assert.deepEqual(listFeedback({ all: true, inboxDir }).unreadable, 0, "ids/ 不被当作条目");
  }));

test("发布写到一半失败：临时文件被清掉，不留半截条目", () =>
  withTempHome("wao-fb-partial-", (home, inboxDir) => {
    const file = writeBody(home, "body.md", "# 半截虚构反馈\n\n正文。\n");
    const partialFs = {
      writeFileSync: (p, content, opts) => {
        if (String(p).includes(".wao-tmp-fb-")) {
          writeFileSync(p, String(content).slice(0, 8));
          throw Object.assign(new Error("simulated disk full"), { code: "ENOSPC" });
        }
        return writeFileSync(p, content, opts);
      },
    };
    assert.throws(() => submitFeedback({ file, inboxDir }, { fs: partialFs }), /simulated disk full/);
    assert.deepEqual(readdirSync(join(inboxDir, "open")), [], "open/ 里既没有条目也没有临时文件");
  }));

test("close 发布：硬链接失败时 open 原样保留、不留已处理副本；已处理副本存在时才删 open", () =>
  withTempHome("wao-fb-close-publish-", (home, inboxDir) => {
    const file = writeBody(home, "body.md", "# 发布虚构反馈\n\n正文。\n");
    const entry = submitFeedback({ file, inboxDir });
    const openPath = entryPath(inboxDir, "open", entry.id);
    const closedPath = entryPath(inboxDir, "closed", entry.id);
    const openRaw = readFileSync(openPath, "utf8");
    const failingLink = { linkSync: () => { throw Object.assign(new Error("simulated I/O failure"), { code: "EIO" }); } };
    assert.throws(() => closeFeedback(entry.id, { note: "虚构处理", inboxDir }, { fs: failingLink }), /simulated I\/O failure/);
    assert.equal(readFileSync(openPath, "utf8"), openRaw, "发布失败时 open 原样保留");
    assert.ok(!existsSync(closedPath), "发布失败不留已处理副本");
    assert.deepEqual(readdirSync(join(inboxDir, "closed")).filter((n) => n.startsWith(".wao-tmp")), [], "临时文件已清掉");
    // 正常关闭之后，第二个关闭方拿到 EEXIST：那份已处理副本完整，才删 open。
    closeFeedback(entry.id, { note: "第一次处理（虚构）", inboxDir });
    writeFileSync(openPath, openRaw);
    assert.throws(() => closeFeedback(entry.id, { note: "第二个关闭方", inboxDir }), /已处理/);
    assert.equal(readJson(closedPath).note, "第一次处理（虚构）");
    assert.ok(!existsSync(openPath));
  }));

test("崩溃窗：closed 已落、open 未删时，list 不计未处理；下一次 close 清掉残留并报'已处理'", () =>
  withTempHome("wao-fb-crashwindow-", (home, inboxDir) => {
    const file = writeBody(home, "body.md", "# 崩溃窗虚构反馈\n\n正文。\n");
    const entry = submitFeedback({ file, inboxDir });
    const openPath = entryPath(inboxDir, "open", entry.id);
    const closedPath = entryPath(inboxDir, "closed", entry.id);
    const openRaw = readFileSync(openPath, "utf8");
    closeFeedback(entry.id, { note: "已经处理过了（虚构）", inboxDir });
    // 模拟“closed 已落、删 open 未完成”的残留。
    writeFileSync(openPath, openRaw);

    const listed = listFeedback({ all: true, inboxDir });
    assert.deepEqual(listed.open, [], "同一 id 去重，以 closed 为准——不算未处理");
    assert.equal(listed.closed.length, 1);
    assert.equal(listed.unreadable, 0, "残留 open 是合法条目，不算读不出");

    assert.throws(() => closeFeedback(entry.id, { note: "再收一次（不该写入）", inboxDir }), /已处理/);
    assert.ok(!existsSync(openPath), "下一次 close 清掉残留的 open 副本");
    assert.equal(readJson(closedPath).note, "已经处理过了（虚构）", "仍不改写已有处理说明");
  }));

test("close 不存在的 id 与空/超长处理说明：都具名报错且不建目录", () =>
  withTempHome("wao-fb-close-errors-", (home, inboxDir) => {
    const id = "fb_20260102T030405Z_aaaaaa";
    assert.throws(() => closeFeedback(id, { note: "虚构", inboxDir }), /没有这条未处理反馈/);
    const file = writeBody(home, "body.md", "# 虚构反馈\n\n正文。\n");
    const entry = submitFeedback({ file, inboxDir });
    assert.throws(() => closeFeedback(entry.id, { note: "   ", inboxDir }), /--note/);
    assert.throws(() => closeFeedback(entry.id, { note: "字".repeat(2001), inboxDir }), /2000/);
    assert.equal(listFeedback({ inboxDir }).open.length, 1, "处理说明不合规时条目仍是未处理");
  }));

// ─────────────────────────────────────────────────────────────────────────────
// 损坏条目与只读面
// ─────────────────────────────────────────────────────────────────────────────

test("损坏条目：JSON 坏或字段缺时，list 照常列出其余条目并另报读不出（不当 0、不崩）", () =>
  withTempHome("wao-fb-corrupt-", (home, inboxDir) => {
    const file = writeBody(home, "body.md", "# 好条目\n\n正文。\n");
    const good = submitFeedback({ file, inboxDir });
    const openDir = join(inboxDir, "open");
    writeFileSync(join(openDir, "fb_20260102T030405Z_zzzzzz.json"), "{ not json");
    writeFileSync(join(openDir, "fb_20260102T030405Z_yyyyyy.json"), JSON.stringify({ schemaVersion: 1, id: "fb_20260102T030405Z_yyyyyy" }));
    writeFileSync(join(openDir, "notes.txt"), "不是条目");
    writeFileSync(join(openDir, ".wao-tmp-1234"), "临时文件");

    const openOnly = listFeedback({ inboxDir });
    assert.equal(openOnly.open.length, 1, "好条目照常列出");
    assert.equal(openOnly.open[0].id, good.id);
    assert.equal(openOnly.unreadable, 2, "两条读不出被计数，不当 0");
    assert.equal(openOnly.closed, undefined, "没有 --all 时 closed 不出现");

    mkdirSync(join(inboxDir, "closed"), { recursive: true });
    writeFileSync(join(inboxDir, "closed", "fb_20260102T030405Z_xxxxxx.json"), "坏 closed");    const all = listFeedback({ all: true, inboxDir });
    assert.equal(all.unreadable, 3, "closed 侧的读不出同样计数");
    assert.ok(all.closed.every((e) => typeof e.id === "string"));
  }));

test("只读面：目录不存在就是 0 条 / 没有这条反馈，且不建目录", () =>
  withTempHome("wao-fb-readonly-", (home) => {
    const missing = join(home, "never-created");
    assert.deepEqual(listFeedback({ inboxDir: missing }), { open: [], unreadable: 0 });
    assert.deepEqual(feedbackInboxHintLines({ inboxDir: missing }), [], "0 条未处理 → 静默");
    assert.throws(() => showFeedback("fb_20260102T030405Z_aaaaaa", { inboxDir: missing }), /没有这条反馈/);
    assert.throws(() => closeFeedback("fb_20260102T030405Z_aaaaaa", { note: "虚构", inboxDir: missing }), /没有这条未处理反馈/);
    assert.ok(!existsSync(missing), "只读与未命中路径都不建目录");
    // show 先找未处理、再找已处理。
    const file = writeBody(home, "body.md", "# 先未处理后已处理\n\n正文。\n");
    const entry = submitFeedback({ file, inboxDir: join(home, "inbox") });
    assert.equal(showFeedback(entry.id, { inboxDir: join(home, "inbox") }).status, "open");
    closeFeedback(entry.id, { note: "收口（虚构）", inboxDir: join(home, "inbox") });
    assert.equal(showFeedback(entry.id, { inboxDir: join(home, "inbox") }).status, "closed");
  }));

// ─────────────────────────────────────────────────────────────────────────────
// 脱敏：与转录同一纪律（写盘前过 createSecretRedactor）
// ─────────────────────────────────────────────────────────────────────────────

test("脱敏：标题、正文、处理说明里的已登记凭据值写盘前被替换", () =>
  withTempHome("wao-fb-redact-", (home, inboxDir) => {
    const secretValue = "test-secret-feedback-value";
    const redactor = createSecretRedactor({ TEST_API_KEY: secretValue });
    const file = writeBody(home, "body.md", `# 标题含 ${secretValue}\n\n正文也含 ${secretValue} 与上下文。\n`);
    const entry = submitFeedback({ file, title: `显式标题 ${secretValue}`, inboxDir }, { redactor });
    const stored = readJson(entryPath(inboxDir, "open", entry.id));
    assert.ok(!JSON.stringify(stored).includes(secretValue), "落盘内容不含原值");
    assert.ok(stored.body.includes("[REDACTED:TEST_API_KEY]"), "正文过同一套脱敏");
    assert.ok(stored.title.includes("[REDACTED:TEST_API_KEY]"), "标题过同一套脱敏");

    // 先脱敏后截断：横跨 120 字符截断点的凭据不能留下前缀。
    const spanning = submitFeedback({ file, title: `${"x".repeat(110)}${secretValue}`, inboxDir }, { redactor });
    const spanningTitle = readJson(entryPath(inboxDir, "open", spanning.id)).title;
    assert.ok(!spanningTitle.includes(secretValue.slice(0, 6)), "截断点上不留凭据前缀");
    assert.equal([...spanningTitle].length, 120);

    const closed = closeFeedback(entry.id, { note: `处理说明含 ${secretValue}`, inboxDir }, { redactor });
    assert.ok(!JSON.stringify(closed).includes(secretValue), "处理说明过同一套脱敏");
    assert.ok(readJson(entryPath(inboxDir, "closed", entry.id)).note.includes("[REDACTED:TEST_API_KEY]"));
  }));

// ─────────────────────────────────────────────────────────────────────────────
// hygiene 提示（注入根，不碰真实收件箱）
// ─────────────────────────────────────────────────────────────────────────────

test("hygiene 提示：0 条静默、N 条打印计数、读不出打印闭集原因，且只打印计数", () =>
  withTempHome("wao-fb-hint-", (home, inboxDir) => {
    const file = writeBody(home, "body.md", "# 提示虚构反馈\n\n正文。\n");
    const first = submitFeedback({ file, inboxDir });
    submitFeedback({ file, inboxDir });

    const lines = feedbackInboxHintLines({ inboxDir });
    assert.equal(lines.length, 1, "有未处理条目时打印一行");
    assert.match(lines[0], /2 条未处理/);
    assert.match(lines[0], /wao feedback list/, "提示里给查看命令");
    assert.ok(!lines[0].includes("提示虚构反馈"), "只打印计数，不打印标题与正文");
    assert.ok(!lines[0].includes("正文。"), "只打印计数，不打印标题与正文");

    // 读不出：条目坏 → entry-unreadable 闭集原因。
    writeFileSync(join(inboxDir, "open", "fb_20260102T030405Z_zzzzzz.json"), "{ broken");
    const withUnreadable = feedbackInboxHintLines({ inboxDir });
    const unreadableLine = withUnreadable.find((l) => l.includes("收件箱读不出"));
    assert.ok(unreadableLine, "读不出时打印'收件箱读不出'");
    assert.ok(unreadableLine.includes("entry-unreadable"), "原因取自闭集");
    assert.ok(FEEDBACK_INBOX_READ_FAILURE_REASONS.includes("entry-unreadable"));
    assert.equal(withUnreadable.length, 2, "未处理一行 + 读不出一行");

    // 目录读不出：注入枚举即抛的 fs 缝 → inbox-dir-unreadable。
    const boomFs = { readdirSync: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } };
    const dirLine = feedbackInboxHintLines({ inboxDir }, { fs: boomFs });
    assert.equal(dirLine.length, 1);
    assert.ok(dirLine[0].includes("收件箱读不出"));
    assert.ok(dirLine[0].includes("inbox-dir-unreadable"));

    // 全部收口 → 回到静默。
    closeFeedback(first.id, { note: "收口（虚构）", inboxDir });
    const second = listFeedback({ inboxDir }).open[0];
    closeFeedback(second.id, { note: "收口（虚构）", inboxDir });
    // 坏条目仍在 → 只剩读不出一行；清掉它后完全静默。
    assert.equal(feedbackInboxHintLines({ inboxDir }).length, 1);
    rmrfRetry(join(inboxDir, "open", "fb_20260102T030405Z_zzzzzz.json"));
    assert.deepEqual(feedbackInboxHintLines({ inboxDir }), [], "0 条未处理且无读不出 → 静默");
  }));

test("hygiene 提示：不传 inboxDir 时按注入的 packageRoot / execGit 解析到主检出", () =>
  withTempHome("wao-fb-hint-deps-", (home) => {
    const primary = join(home, "primary");
    const inboxDir = join(primary, ".wao", "inbox");
    const file = writeBody(home, "hint.md", "# 提示解析\n复现：虚构\n");
    submitFeedback({ file, inboxDir });
    const lines = feedbackInboxHintLines({}, {
      packageRoot: join(home, "worktree"),
      execGit: (args) => {
        if (args[0] === "worktree") return `worktree ${primary}\nHEAD 0000000\n`;
        throw new Error("unexpected git call");
      },
    });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /1 条未处理/);
  }));

test("hygiene-cli：提示不参与 W1-W5 判定，PASS 文案与退出码不变", () => {
  const src = readFileSync(join(REPO_ROOT, "scripts", "hygiene-cli.mjs"), "utf8");
  assert.ok(src.includes('"hygiene: PASS (5/5)"'), "PASS 文案不变");
  assert.ok(src.includes("`hygiene: FAIL (${fail} red)"), "FAIL 文案不变");
  assert.ok(src.includes("process.exit(fail === 0 ? 0 : 1)"), "退出码不变");
  assert.ok(/try \{[\s\S]*feedbackInboxHintLines\([\s\S]*\} catch/.test(src),
    "收件箱提示在独立 try/catch 内（任何异常都被吞掉，不让 hygiene 提前终止）");
  assert.ok(/\badd\("W1"/.test(src) && /\badd\("W5"/.test(src), "W1-W5 检查仍是五个");
});

// ─────────────────────────────────────────────────────────────────────────────
// git：忽略面 + 零跟踪；CLI 注册与生成层
// ─────────────────────────────────────────────────────────────────────────────

test("git：.wao/inbox/ 被忽略，且没有任何被跟踪的文件（脱敏守卫防 git add -f）", () => {
  const probe = ".wao/inbox/open/fb_20260102T030405Z_aaaaaa.json";
  const ignored = spawnSync("git", ["check-ignore", "-q", "--", probe], { cwd: REPO_ROOT });
  assert.equal(ignored.status, 0, "git check-ignore 认 .wao/inbox/ 为忽略路径");
  const tracked = spawnSync("git", ["ls-files", "--", ".wao/inbox"], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal((tracked.stdout ?? "").trim(), "", "收件箱下没有任何被 git 跟踪的文件");

  const guard = readFileSync(join(REPO_ROOT, "test", "isolation-infra", "desensitization.test.js"), "utf8");
  assert.ok(guard.includes(String.raw`\.wao\/inbox\/`), "desensitization 敏感路径守卫收录了 .wao/inbox/（防 git add -f）");
});

test("CLI：feedback 进 COMMAND_NAMES 闭集与 HELP_TEXT，生成层内嵌同一份帮助", () => {
  assert.ok(COMMAND_NAMES.includes("feedback"), "顶层命令名闭集收录 feedback");
  for (const sub of ["submit", "list", "show", "close"]) {
    assert.match(HELP_TEXT, new RegExp(`^  feedback ${sub} `, "m"), `HELP_TEXT 有 feedback ${sub} 用法行`);
  }
  const cliMd = readFileSync(join(REPO_ROOT, "docs", "surface", "cli.md"), "utf8");
  assert.ok(cliMd.includes(HELP_TEXT), "docs/surface/cli.md 内嵌当前 HELP_TEXT（跑 npm run gen:surface 更新）");
});

test("CLI 端到端：list → submit → show → close → list --all 走同一份 --inbox-dir", () =>
  withTempHome("wao-fb-cli-", (home, inboxDir) => {
    const empty = runCli(["feedback", "list", "--inbox-dir", inboxDir, "--format", "json"], home);
    assert.equal(empty.status, 0, empty.stderr);
    assert.deepEqual(JSON.parse(empty.stdout), { open: [], unreadable: 0 }, "空收件箱 = 0 条，不建目录");
    assert.ok(!existsSync(inboxDir), "只读 list 不建目录");

    const file = writeBody(home, "body.md", "# CLI 虚构反馈\n\n最小复现：虚构命令。\n");
    const submitted = runCli(["feedback", "submit", "--file", file, "--inbox-dir", inboxDir, "--format", "json"], home);
    assert.equal(submitted.status, 0, submitted.stderr);
    const receipt = JSON.parse(submitted.stdout);
    assert.match(receipt.id, ID_SHAPE);
    assert.equal(receipt.path, `open/${receipt.id}.json`, "回执给出条目相对位置 open/<id>.json");

    const shown = runCli(["feedback", "show", receipt.id, "--inbox-dir", inboxDir, "--format", "json"], home);
    assert.equal(shown.status, 0, shown.stderr);
    assert.equal(JSON.parse(shown.stdout).feedback.status, "open");

    const closed = runCli(["feedback", "close", receipt.id, "--note", "已按虚构方案收口", "--inbox-dir", inboxDir], home);
    assert.equal(closed.status, 0, closed.stderr);
    assert.match(closed.stdout, /feedback closed/);

    const all = runCli(["feedback", "list", "--all", "--inbox-dir", inboxDir, "--format", "json"], home);
    assert.equal(all.status, 0, all.stderr);
    const parsed = JSON.parse(all.stdout);
    assert.deepEqual(parsed.open, []);
    assert.equal(parsed.closed.length, 1);
    assert.equal(parsed.closed[0].id, receipt.id);

    const bad = runCli(["feedback", "close", "..", "--note", "虚构", "--inbox-dir", inboxDir], home);
    assert.notEqual(bad.status, 0, "非法 id 退出非零");
    assert.match(bad.stderr, /非法反馈 id/);
  }));
