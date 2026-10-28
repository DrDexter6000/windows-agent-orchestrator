// src/gitPrivateIndex.js
//
// 私有索引副本：让"读工作树的 git diff"刷新不到真实索引。
//
// 为什么：`--no-optional-locks` 与 GIT_OPTIONAL_LOCKS=0 都拦不住 diff.autoRefreshIndex
// 驱动的索引写回——`git diff ... HEAD`（比较含工作树的形态）会顺手把刷新后的
// stat 数据写回 .git/index（经 index.lock；Git 2.50.1 实测 do_write_index）。
// 只读路径因此碰真实索引：进程在持锁时被结束会留下 0 字节残锁，同一工作树
// 之后一切要写索引的操作（交付打包的 git add/commit）以 git_index_locked 失败。
// `--cached` 的 diff 不看工作树、不刷新，不在本模块的服务范围。
//
// 做法：把真实索引复制进 os.tmpdir() 下新建的唯一临时目录，GIT_INDEX_FILE 指
// 向副本再跑 diff——刷新写回落在副本上，真实索引文件字节不动、不拿它的
// index.lock，比较语义不变。
//
// split-index：副本写回时若另写一份共享索引，git 会顺手清理过期的
// .git/sharedindex.*，连真实索引仍在引用的那份也删（splitIndex.sharedIndexExpire
// =now 时实测删掉，真实索引随即打不开）。所以同一条命令还关掉 core.splitIndex：
// 副本按完整索引写回，不写也不删共享索引文件（读副本时 git 仍会刷新被引用那份的
// 时间戳）。这个设置追加在 GIT_CONFIG_PARAMETERS 末尾——git 先读 GIT_CONFIG_COUNT
// 条目、再按顺序读 GIT_CONFIG_PARAMETERS，同一键以最后读到的为准，继承来的任何
// 设置（含 `git -c` 传下来的）都盖不过它。
//
// racy-git 防漏报：git 判断"同一时刻被改过的文件"靠比较各条目 mtime 与索引文件
// 自身 mtime（entry.mtime >= index.mtime 即 racy，强制内容比对）。副本若带着比
// 原索引更新的 mtime，原本 racy 的条目会变成可信 stat、漏报改动。复制后把副本
// 的 atime/mtime 设成原索引的值再往前拨 1 秒（JS 浮点秒精度不足以原样复制）：
// 更早只会让更多条目被判 racy、多做内容比对，结果总是对的。
//
// 不起任何 git 子进程（node 内置模块 only）。索引文件不存在（全新仓库）或准备
// 副本失败 → 返回 null，调用方按原样直接跑，即回到引入本模块前的行为：真实索引
// 照旧可能被刷新写回。刻意不在这里判失败：临时目录坏掉时宁可退回旧行为，也不让
// 交付打包、候选清点与回收指纹因此报错。

import { copyFileSync, mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 只对这一条 git 命令关掉 core.splitIndex（见文件头 split-index 说明）：追加在
 * baseEnv 已有的 GIT_CONFIG_PARAMETERS 末尾，保留其余条目。
 * @param {object} baseEnv
 * @returns {{GIT_CONFIG_PARAMETERS: string}}
 */
function splitIndexOffEnv(baseEnv) {
  const inherited = (baseEnv.GIT_CONFIG_PARAMETERS ?? "").trim();
  const entry = "'core.splitIndex=false'";
  return { GIT_CONFIG_PARAMETERS: inherited === "" ? entry : `${inherited} ${entry}` };
}

/**
 * 复制真实索引到私有临时副本。
 *
 * @param {string} realIndexPath — 真实索引文件的绝对路径（调用方经
 *   `git rev-parse --git-path index` 输出按 cwd resolve 得到）
 * @param {object} [baseEnv] — 调用方要在其上叠加 `env` 的环境（缺省 process.env）
 * @returns {{env: object, dispose(): void}|null} env = GIT_INDEX_FILE 指向副本，
 *   外加关掉 core.splitIndex 的 GIT_CONFIG_PARAMETERS，调用方叠加在 baseEnv 上。null =
 *   没有可复制的索引（或复制失败），调用方按原样直接跑。dispose() 删除整个临时
 *   目录（含 git 可能留下的 `副本.lock`），可重复调用、不抛错。
 */
export function createPrivateIndexCopy(realIndexPath, baseEnv = process.env) {
  let st;
  try {
    st = statSync(realIndexPath);
  } catch {
    return null; // 全新仓库等无索引形态
  }
  let dir = null;
  try {
    dir = mkdtempSync(join(tmpdir(), "wao-private-index-"));
    const copyPath = join(dir, "index");
    copyFileSync(realIndexPath, copyPath);
    // 副本 mtime 不晚于原索引（再往前拨 1 秒）：见文件头 racy-git 说明。
    const backDated = new Date(Math.floor(st.mtimeMs) - 1000);
    utimesSync(copyPath, backDated, backDated);
    let disposed = false;
    return {
      env: { GIT_INDEX_FILE: copyPath, ...splitIndexOffEnv(baseEnv) },
      dispose() {
        if (disposed) return;
        disposed = true;
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch { /* 尽力而为：不抛错 */ }
      },
    };
  } catch {
    if (dir !== null) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch { /* 尽力而为 */ }
    }
    return null; // 复制失败：降级为按原样直接跑（调用方既有失败语义不变）
  }
}
