// src/commands/manual.js
//
// `wao manual` 命令族（决定 0115）：在任何目录按页/按节读 WAO 使用手册。
// 薄 CLI 适配——只做 argv 处理、输出排版与 console/stdout 输出；解析与匹配
// 全部在共享 application 服务 ../application/manual.js（地图页表生成器与
// docs-consistency 指针守卫用同一份解析）。
//
// 四种用法：
//   manual                    列各页（页名、标题、read_when、字节数）
//   manual <页>               先打印该页 read_when，再列节（标题与字节数）
//   manual <页> <节>          第一行写源文件绝对路径与节标题，随后按字节原样输出该节
//   manual <页> --all         同上形状，输出整页
//
// 页名只能从实际页清单里选（findManualPage），不拼接用户给的路径；节名带空格时
// 调用方要加引号（一个 argv 元素）。只读：不写任何文件。

import { parseOptions } from "./shared.js";
import { readManualIndex, findManualPage, resolveManualSection } from "../application/manual.js";

/** 位置参数 = 不以 -- 开头的 argv（节名含空格时调用方引号括成一个参数）。 */
function positionalsOf(args) {
  return args.filter((a) => !a.startsWith("--"));
}

async function manualCommand(args, config, deps = {}) {
  // 只认 --all：未知的 -- 旗标一律报错（它的值也不许被当成节名）。
  const unknownFlags = args.filter((a) => a.startsWith("--") && a !== "--all");
  if (unknownFlags.length > 0) {
    throw new Error(`manual 不认识旗标 ${unknownFlags.join(" ")}（只认 --all）`);
  }
  const options = parseOptions(args);
  const positionals = positionalsOf(args);
  const index = readManualIndex(deps);

  if (positionals.length === 0) {
    if (options.all) throw new Error("manual --all 需要页名：manual <页> --all");
    for (const page of index.pages) {
      console.log([page.name, page.title, `${page.bytes}B`, page.readWhen].join("\t"));
    }
    return;
  }

  const [pageArg, sectionArg, ...extra] = positionals;
  if (extra.length > 0) {
    throw new Error(
      `manual 最多接受页名与节名两个参数（多了: ${extra.join(" ")}；节名含空格时用引号括成一个参数）`,
    );
  }
  const page = findManualPage(index, pageArg);

  if (options.all) {
    if (sectionArg !== undefined) throw new Error("manual <页> --all 与节名互斥（--all 输出整页）");
    console.log(`源: ${page.path}\t页: ${page.title}`);
    process.stdout.write(Buffer.from(page.text, "utf8"));
    return;
  }
  if (sectionArg === undefined) {
    console.log(`read_when: ${page.readWhen}`);
    for (const section of page.sections) {
      console.log(`${"#".repeat(section.level)} ${section.heading}\t${section.bytes}`);
    }
    return;
  }
  // 显式给了节名（含空串 ""）都走匹配：空串由解析器按零命中报错（非零退出），
  // 不落回列节分支。
  const section = resolveManualSection(page, sectionArg);
  console.log(`源: ${page.path}\t节: ${section.heading}`);
  process.stdout.write(Buffer.from(page.text.slice(section.startOffset, section.endOffset), "utf8"));
}

export { manualCommand };
