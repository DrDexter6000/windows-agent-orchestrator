// test/application/lineageSlotStore.test.js
//
// 第 154 批（决定 0133 修正三·3）：谱系槽写入失败不留残留，且只清自己建的东西。
//   - 写临时文件 / rename 失败（EACCES）→ 删自己的 .tmp-*，锁目录与自己建的父目录回收；
//   - 写锁内容失败 → 关句柄、删自己的锁文件，目录回收；
//   - 槽忙（没写任何条目）→ 回收自己建的空 .locks 目录，别人的条目与目录不动；
//   - 成功路径照旧（锁目录保留）；
//   - 槽存储失败包成 LineageSlotStorageError（message 不变），编程/校验错误原样上抛。
// 失败用 createLineageStore 的 io 注入缝确定性触发；不依赖机器的文件权限。

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LineageSlotStorageError,
  createLineageStore,
  deriveLineageReuseKeyHash,
  releaseLineageFirstTurn,
  resolveLineageFirstTurn,
} from "../../src/application/sessionReuse.js";

const MATERIAL = { laneFingerprint: "lane:0123456789abcdef", roleSha256: "none" };
const BASE = { workspace: "D:/proj", agentId: "coder_hq", rootRunId: "run_b154_store_root", ...MATERIAL };

function withRunDir(fn) {
  const runDir = mkdtempSync(join(tmpdir(), "wao-b154-slot-"));
  return Promise.resolve(fn(runDir)).finally(() => rmSync(runDir, { recursive: true, force: true }));
}
const fsError = (code, syscall) => Object.assign(new Error(`${code}: fixture ${syscall} failure`), { code, syscall });
const leftovers = (runDir) => (existsSync(join(runDir, ".lineage-reuse"))
  ? readdirSync(join(runDir, ".lineage-reuse"), { recursive: true })
  : null);

test("rename 出 EACCES：LineageSlotStorageError（message 不变），自己的 .tmp-* 与自己建的目录都清掉，没有条目", async () => {
  await withRunDir(async (runDir) => {
    const store = createLineageStore(runDir, { rename: async () => { throw fsError("EACCES", "rename"); } });
    await assert.rejects(
      () => resolveLineageFirstTurn({ runDir, runId: "run_b154_store_root", ...BASE, reuseStore: store }),
      (error) => error instanceof LineageSlotStorageError && error.code === "EACCES" && /EACCES: fixture rename failure/.test(error.message),
    );
    assert.equal(leftovers(runDir), null, "槽目录是这次调用建的：失败后整条链回收，没有 .tmp-*、没有 .locks、没有条目");
  });
});

test("rename 出 EACCES 时槽目录已存在（别人的条目在里面）：只清自己的临时文件和自己建的 .locks，别人的条目与目录不动", async () => {
  await withRunDir(async (runDir) => {
    const slotDir = join(runDir, ".lineage-reuse");
    mkdirSync(slotDir, { recursive: true });
    writeFileSync(join(slotDir, "someone-else.json"), "{\"runId\":\"run_other\",\"updatedAt\":1}", "utf8");
    const store = createLineageStore(runDir, { rename: async () => { throw fsError("EACCES", "rename"); } });
    await assert.rejects(
      () => resolveLineageFirstTurn({ runDir, runId: "run_b154_store_root", ...BASE, reuseStore: store }),
      LineageSlotStorageError,
    );
    assert.deepEqual(readdirSync(slotDir), ["someone-else.json"], "只剩别人的条目");
  });
});

test("写临时文件失败（ENOSPC）：同样不留 .tmp-*", async () => {
  await withRunDir(async (runDir) => {
    const seen = [];
    const store = createLineageStore(runDir, {
      writeFile: async (path, ...rest) => {
        // 先真写出一半内容（留下一个临时文件），再失败——清理要把它删掉。
        if (String(path).includes(".tmp-")) {
          writeFileSync(path, "{", "utf8");
          seen.push(String(path));
          throw fsError("ENOSPC", "write");
        }
        const { writeFile } = await import("node:fs/promises");
        return writeFile(path, ...rest);
      },
    });
    await assert.rejects(
      () => resolveLineageFirstTurn({ runDir, runId: "run_b154_store_root", ...BASE, reuseStore: store }),
      (error) => error instanceof LineageSlotStorageError && error.code === "ENOSPC",
    );
    assert.equal(seen.length, 1, "夹具：确实写出过一个临时文件");
    assert.equal(leftovers(runDir), null);
  });
});

test("写锁内容失败：关句柄、删自己刚建的锁文件，回收自己建的目录；错误按槽存储失败上抛", async () => {
  await withRunDir(async (runDir) => {
    let closed = 0;
    const store = createLineageStore(runDir, {
      open: async (path, flags) => {
        const handle = await open(path, flags);
        return {
          writeFile: async () => { throw fsError("ENOSPC", "write"); },
          close: async () => { closed += 1; return handle.close(); },
        };
      },
    });
    await assert.rejects(
      () => resolveLineageFirstTurn({ runDir, runId: "run_b154_store_root", ...BASE, reuseStore: store }),
      (error) => error instanceof LineageSlotStorageError && error.code === "ENOSPC",
    );
    assert.equal(closed, 1, "句柄已关");
    assert.equal(leftovers(runDir), null, "没有遗留的锁文件，也没有遗留目录");
  });
});

test("槽忙（没写任何条目）：回收自己建的空 .locks，别人的条目原样不动；槽目录是别人先建的就保留", async () => {
  await withRunDir(async (runDir) => {
    const slotDir = join(runDir, ".lineage-reuse");
    mkdirSync(slotDir, { recursive: true });
    const keyHash = deriveLineageReuseKeyHash(BASE);
    const file = join(slotDir, `${keyHash}.json`);
    writeFileSync(file, JSON.stringify({ runId: "run_b154_store_child", updatedAt: Date.now() }), "utf8");
    const before = readFileSync(file, "utf8");
    const result = await resolveLineageFirstTurn({ runDir, runId: "run_b154_store_root", ...BASE });
    assert.equal(result.kind, "busy");
    assert.equal(result.activeRunId, "run_b154_store_child");
    assert.equal(readFileSync(file, "utf8"), before);
    assert.deepEqual(readdirSync(slotDir), [`${keyHash}.json`], "没有空的 .locks 目录");
  });
});

test("成功路径照旧：条目写入、claim 凭据带回、锁目录保留（失败清理不影响成功）", async () => {
  await withRunDir(async (runDir) => {
    const result = await resolveLineageFirstTurn({ runDir, runId: "run_b154_store_root", ...BASE });
    assert.equal(result.kind, "first");
    assert.equal(result.routing.mode, "run_lineage");
    assert.deepEqual(result.claim, {
      keyHash: deriveLineageReuseKeyHash(BASE), runId: "run_b154_store_root", previousEntry: null,
    });
    assert.ok(existsSync(join(runDir, ".lineage-reuse", `${result.claim.keyHash}.json`)));
    assert.ok(existsSync(join(runDir, ".lineage-reuse", ".locks")), "成功路径保持原样");
  });
});

test("撤回：槽仍是自己 → 恢复写入前的状态（无前任 = 删除）；已被别人接手 → 不动；撤回自己建出来的目录之外不动", async () => {
  await withRunDir(async (runDir) => {
    const claimed = await resolveLineageFirstTurn({ runDir, runId: "run_b154_store_root", ...BASE });
    const file = join(runDir, ".lineage-reuse", `${claimed.claim.keyHash}.json`);
    assert.equal(await releaseLineageFirstTurn({ runDir, claim: claimed.claim }), true);
    assert.equal(existsSync(file), false);
    assert.equal(await releaseLineageFirstTurn({ runDir, claim: claimed.claim }), false, "再撤一次 = 无操作");
    // 别人接手后撤回不动对方。
    writeFileSync(file, JSON.stringify({ runId: "run_b154_store_child", updatedAt: Date.now() }), "utf8");
    assert.equal(await releaseLineageFirstTurn({ runDir, claim: claimed.claim }), false);
    assert.match(readFileSync(file, "utf8"), /run_b154_store_child/);
    // 有前任条目的撤回：恢复前任。
    const previous = { runId: "run_b154_store_prior", updatedAt: 1 };
    const claimToken = { keyHash: claimed.claim.keyHash, runId: "run_b154_store_root", previousEntry: previous };
    writeFileSync(file, JSON.stringify({ runId: "run_b154_store_root", updatedAt: Date.now() }), "utf8");
    assert.equal(await releaseLineageFirstTurn({ runDir, claim: claimToken }), true);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), previous);
  });
});

test("只把槽存储失败包成 LineageSlotStorageError：条目损坏算；校验/编程错误原样上抛", async () => {
  await withRunDir(async (runDir) => {
    // 条目损坏（存在但不可解析）= 存储失败。
    const slotDir = join(runDir, ".lineage-reuse");
    mkdirSync(slotDir, { recursive: true });
    writeFileSync(join(slotDir, `${deriveLineageReuseKeyHash(BASE)}.json`), "not json", "utf8");
    await assert.rejects(
      () => resolveLineageFirstTurn({ runDir, runId: "run_b154_store_root", ...BASE }),
      (error) => error instanceof LineageSlotStorageError && /damaged/.test(error.message),
    );
    // 非法 agentId = 校验错误：不是存储失败，不包装。
    await assert.rejects(
      () => resolveLineageFirstTurn({ runDir, runId: "run_b154_store_root", ...BASE, agentId: "Not A Valid Id!" }),
      (error) => !(error instanceof LineageSlotStorageError) && /agentId must be a valid canonical id/.test(error.message),
    );
  });
});
