// src/commands/feedback.js
//
// `wao feedback` CLI 适配：本机反馈收件箱（宿主项目 Lead 报 WAO 缺陷 → WAO 开发
// Lead 收口）。收件箱在哪、条目长什么样、并发与失败后的状态，全部由
// ../application/feedbackInbox.js 决定——本文件只做 argv、格式与 console。
//
// 子命令：
//   submit --file <md> [--title <text>] [--inbox-dir DIR] [--format json]
//   list [--all] [--inbox-dir DIR] [--format json]
//   show <id> [--inbox-dir DIR] [--format json]
//   close <id> --note <text> [--inbox-dir DIR] [--format json]
//
// 只读命令（list/show）不建目录：目录不存在就是 0 条 / 没有这条反馈。
// 不联网、不调用模型、不写收件箱以外的任何位置。

import { parseOptions } from "./shared.js";
import {
  closeFeedback,
  listFeedback,
  showFeedback,
  submitFeedback,
} from "../application/feedbackInbox.js";

async function feedbackCommand(args, config) {
  const [sub, ...tail] = args;
  if (sub === "submit") return feedbackSubmitCommand(tail);
  if (sub === "list") return feedbackListCommand(tail);
  if (sub === "show") return feedbackShowCommand(tail);
  if (sub === "close") return feedbackCloseCommand(tail);
  throw new Error(
    `Unknown feedback subcommand: ${sub ?? "(none)"}. Try: feedback submit --file <md> | feedback list [--all] | feedback show <id> | feedback close <id> --note <text>`,
  );
}

/** 第一个位置参数（跳过 --flag 与其值）——id 在 argv 里的位置不固定。 */
function firstPositional(args) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const next = args[i + 1];
      if (next && !next.startsWith("--")) i += 1;
      continue;
    }
    return arg;
  }
  return undefined;
}

function sourceLine(source) {
  return `${source.projectLabel ?? "(none)"} @ ${source.waoCommit ?? "(unknown)"}`;
}

function renderEntryText(entry) {
  const lines = [
    `id: ${entry.id}`,
    `receivedAt: ${entry.receivedAt}`,
    `title: ${entry.title}`,
    `status: ${entry.status}`,
    `source: ${sourceLine(entry.source)}`,
  ];
  if (entry.status === "closed") {
    lines.push(`closedAt: ${entry.closedAt}`);
    lines.push(`note: ${entry.note}`);
  }
  lines.push("", entry.body);
  return lines.join("\n");
}

function feedbackSubmitCommand(args) {
  const options = parseOptions(args);
  const entry = submitFeedback({
    file: options.file,
    title: options.title,
    inboxDir: options.inboxDir,
  });
  if (options.format === "json") {
    console.log(JSON.stringify({
      id: entry.id,
      receivedAt: entry.receivedAt,
      title: entry.title,
      status: entry.status,
      source: entry.source,
      path: entry.relativePath,
    }, null, 2));
    return;
  }
  console.log(`feedback submitted: ${entry.id}`);
  console.log(entry.relativePath);
}

function feedbackListCommand(args) {
  const options = parseOptions(args);
  const result = listFeedback({ all: options.all === true, inboxDir: options.inboxDir });
  if (options.format === "json") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const rows = result.open.map((entry) => ["open", entry]);
  if (result.closed) for (const entry of result.closed) rows.push(["closed", entry]);
  for (const [status, entry] of rows) {
    console.log([status, entry.id, entry.receivedAt, entry.title, sourceLine(entry.source)].join("\t"));
  }
  if (result.unreadable > 0) console.log(`（另有 ${result.unreadable} 条读不出）`);
}

function feedbackShowCommand(args) {
  const options = parseOptions(args);
  const id = firstPositional(args);
  if (!id) throw new Error("feedback show 需要 <id>. 用 feedback list 看有哪些 id。");
  const entry = showFeedback(id, { inboxDir: options.inboxDir });
  if (options.format === "json") {
    console.log(JSON.stringify({ feedback: entry }, null, 2));
    return;
  }
  console.log(renderEntryText(entry));
}

function feedbackCloseCommand(args) {
  const options = parseOptions(args);
  const id = firstPositional(args);
  if (!id) throw new Error("feedback close 需要 <id> 与 --note <text>.");
  const entry = closeFeedback(id, { note: options.note, inboxDir: options.inboxDir });
  if (options.format === "json") {
    console.log(JSON.stringify({ feedback: entry }, null, 2));
    return;
  }
  console.log(`feedback closed: ${entry.id}`);
  console.log(renderEntryText(entry));
}

export { feedbackCommand };
