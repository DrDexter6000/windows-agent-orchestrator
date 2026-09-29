// test/isolation-infra/dispatchResourceAdvisory.test.js
//
// ADR 0035 S3：派发启动 advisory 资源计数行（src/dispatchResourceAdvisory.js）
// 的纯单元测试——注入 fake 子进程执行器（runDispatch spawnFn 先例），零真实
// git 子进程、零文件系统写入。
//
// 状态覆盖（WQ-02 纪律，同步单次调用无 loading/stale 态）：
//   · 正常计数（LF）→ 行出现且整行全等（仅有的动态内容 = 两个数字）；
//   · 正常计数（CRLF——Windows git 真实输出形态）→ 计数不漂；
//   · 零 wao/run_* 分支（空输出）→ waoRunBranches=0 照常成行；
//   · 执行器在 worktree 计数抛错 → null 且不抛（fail-open）；
//   · 执行器在分支计数抛错（首个调用成功）→ null；
//   · 抛超时形态错误（execSync timeout kill 的 ETIMEDOUT/killed 真实形态）→ null；
//   · 输出非字符串（不可解析）→ null（与子进程失败同待遇）；
//   · 执行器 options 携带同一有界 timeout + windowsHide（fail-open 的有界等待）。
//
// 未覆盖面（明示）：真实 git 子进程行为（cwd 非 git 仓、git 不存在、真实超时）
// 全部坍缩进同一 catch 的 fail-open 路径，由"执行器抛错 → null"等价钉死；
// runCommand 的 console.error 挂接（3 行 wiring）不在纯单测覆盖——由直接消费
// 者既有测试（readOnlyDispatch RO-C4 等真跑 runCommand）守护不回归。

import test from "node:test";
import assert from "node:assert/strict";

import {
  renderDispatchResourceAdvisory,
  ADVISORY_GIT_TIMEOUT_MS,
} from "../../src/dispatchResourceAdvisory.js";

const WORKTREE_PORCELAIN = [
  "worktree D:/proj/main",
  "HEAD 1111111111111111111111111111111111111111",
  "branch refs/heads/main",
  "",
  "worktree D:/proj/.wao-worktrees/run_x",
  "HEAD 2222222222222222222222222222222222222222",
  "branch refs/heads/wao/run_x",
  "",
].join("\n");

const BRANCH_LIST = [
  "  wao/run_x",
  "* wao/run_yyy",
  "  wao/run_z",
].join("\n");

/** 按序回放响应的 fake 执行器：Error 实例 → 抛出；否则作为 stdout 返回。 */
function makeFakeExec(responses) {
  const calls = [];
  const fakeExec = (command, options) => {
    calls.push({ command, options });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { fakeExec, calls };
}

test("S3-1: 正常计数 → 行出现且整行全等；两命令与 options 形状钉死", () => {
  const { fakeExec, calls } = makeFakeExec([WORKTREE_PORCELAIN, BRANCH_LIST]);
  const line = renderDispatchResourceAdvisory("D:/proj", { exec: fakeExec });
  assert.equal(
    line,
    "[wao] advisory: worktrees=2 waoRunBranches=3 (npm run hygiene for details)",
  );
  assert.equal(calls.length, 2, "恰两次子进程调用");
  assert.equal(calls[0].command, "git worktree list --porcelain");
  assert.equal(calls[1].command, 'git branch --list "wao/run_*"');
  for (const c of calls) {
    assert.equal(c.options.cwd, "D:/proj");
    assert.equal(c.options.encoding, "utf8");
    assert.equal(c.options.windowsHide, true);
  }
});

test("S3-2: CRLF 输出（Windows git 真实形态）→ 计数不漂", () => {
  const { fakeExec } = makeFakeExec([
    WORKTREE_PORCELAIN.split("\n").join("\r\n"),
    BRANCH_LIST.split("\n").join("\r\n"),
  ]);
  const line = renderDispatchResourceAdvisory("D:/proj", { exec: fakeExec });
  assert.equal(
    line,
    "[wao] advisory: worktrees=2 waoRunBranches=3 (npm run hygiene for details)",
  );
});

test("S3-3: 零 wao/run_* 分支（空输出）→ waoRunBranches=0 照常成行", () => {
  const singleMain = "worktree D:/proj/main\nHEAD 1111\nbranch refs/heads/main\n";
  const { fakeExec } = makeFakeExec([singleMain, "\n"]);
  const line = renderDispatchResourceAdvisory("D:/proj", { exec: fakeExec });
  assert.equal(
    line,
    "[wao] advisory: worktrees=1 waoRunBranches=0 (npm run hygiene for details)",
  );
});

test("S3-4: 执行器在 worktree 计数抛错 → 返回 null 且不抛（fail-open 省略整行）", () => {
  const { fakeExec } = makeFakeExec([new Error("spawn git ENOENT")]);
  let line = "unset";
  assert.doesNotThrow(() => {
    line = renderDispatchResourceAdvisory("D:/not-a-repo", { exec: fakeExec });
  });
  assert.equal(line, null, "无占位文案、无错误行——整行省略");
});

test("S3-5: 执行器在分支计数抛错（首个调用成功）→ 同样省略整行", () => {
  const { fakeExec } = makeFakeExec([WORKTREE_PORCELAIN, new Error("boom")]);
  const line = renderDispatchResourceAdvisory("D:/proj", { exec: fakeExec });
  assert.equal(line, null, "任一计数失败 → 整行省略（不出现半截计数）");
});

test("S3-6: 抛超时形态错误（execSync timeout kill → ETIMEDOUT/killed）→ 同一 fail-open 路径", () => {
  const timeoutErr = Object.assign(new Error("spawn ETIMEDOUT"), {
    code: "ETIMEDOUT",
    killed: true,
    signal: "SIGTERM",
  });
  const { fakeExec } = makeFakeExec([timeoutErr]);
  const line = renderDispatchResourceAdvisory("D:/proj", { exec: fakeExec });
  assert.equal(line, null, "超时 kill 与失败同路径：整行省略");
});

test("S3-7: 输出非字符串（不可解析）→ null（与子进程失败同待遇）", () => {
  const { fakeExec } = makeFakeExec([undefined]);
  const line = renderDispatchResourceAdvisory("D:/proj", { exec: fakeExec });
  assert.equal(line, null);
});

test("S3-8: 每次调用携带同一有界 timeout（fail-open 的有界等待）+ windowsHide", () => {
  const { fakeExec, calls } = makeFakeExec([WORKTREE_PORCELAIN, BRANCH_LIST]);
  renderDispatchResourceAdvisory("D:/proj", { exec: fakeExec });
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.equal(c.options.timeout, ADVISORY_GIT_TIMEOUT_MS);
    assert.ok(
      Number.isFinite(c.options.timeout) && c.options.timeout > 0 && c.options.timeout <= 5000,
      "advisory 计数不得长时间拖住派发启动（单调用 ≤5s）",
    );
    assert.equal(c.options.windowsHide, true);
  }
});
