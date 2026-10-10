// test/migration-0045/rolePolicy.test.js
//
// 0045 R4/W4b："终局复用策略归角色"落地——角色政策登记（config/roles.json）+
// 生效规则（角色政策优先；席位字段仅限原生角色兼容；跨帽/显式绝不继承）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import {
  loadRolePolicies, effectiveSessionReuse, SESSION_REUSE_POLICIES,
} from "../../src/dispatchResolution.js";

const REPO = join(import.meta.dirname, "../..");

test("POL-1: 政策登记加载——活体 researcher=lead_workspace，其余角色缺席；结构闭集钉", () => {
  const p = loadRolePolicies();
  assert.ok(p.ok, `结构 issues：${JSON.stringify(p.issues)}`);
  assert.equal(p.roles.researcher?.sessionReuse, "lead_workspace");
  assert.equal(p.roles.coder_low, undefined, "无政策角色缺席（非 null 填充）");
  assert.deepEqual([...SESSION_REUSE_POLICIES], ["lead_workspace"]);
});

test("POL-2: 生效规则——角色政策优先；席位字段仅限原生角色兼容；跨帽绝不继承", () => {
  const policies = { researcher: { sessionReuse: "lead_workspace" } };
  const seatResearcher = { systemPrompt: "config/roles/researcher.md", sessionReuse: "lead_workspace" };
  const seatCoderLow = { systemPrompt: "config/roles/coder_low.md", sessionReuse: undefined };
  // ① 角色政策（登记在册）
  assert.equal(effectiveSessionReuse({ roleId: "researcher", agent: seatCoderLow, rolePolicies: policies }), "lead_workspace",
    "角色政策优先（接线席位无关）");
  // ② 席位兼容：无登记+派发角色=席位原生角色+席位自带字段
  const seatLegacy = { systemPrompt: "config/roles/auditor.md", sessionReuse: "lead_workspace" };
  assert.equal(effectiveSessionReuse({ roleId: "auditor", agent: seatLegacy, rolePolicies: policies }), "lead_workspace",
    "未登记角色+席位原生角色+席位自带=兼容生效（过渡期）");
  // ③ 跨帽：席位字段绝不继承给其他角色
  assert.equal(effectiveSessionReuse({ roleId: "tester", agent: seatLegacy, rolePolicies: policies }), null,
    "跨帽派发不继承席位策略（R4 裁定核心）");
  // ④ 无政策
  assert.equal(effectiveSessionReuse({ roleId: "coder_low", agent: seatCoderLow, rolePolicies: policies }), null);
  assert.equal(effectiveSessionReuse({ roleId: undefined, agent: seatCoderLow, rolePolicies: policies }), null);
});

function makeGitRepo(dir) {
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email t@t.com", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name T", { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# t\n", "utf8");
  execSync("git add README.md", { cwd: dir, stdio: "pipe" });
  execSync("git commit -m i", { cwd: dir, stdio: "pipe" });
}
function cleanupDir(dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }

test("POL-3: dispatchRun——researcher 别名（角色政策）进复用路由且材料随行；explicit 换帽同车道不进（真门）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-pol3-"));
  try {
    makeGitRepo(dir);
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: {
      researcher: { backend: "claude-code", cwd: dir }, // 注意：席位不再自带 sessionReuse——政策在角色
    } }), "utf8");
    const { dispatchRun } = await import("../../src/application/runDispatch.js");
    let leadSeq = 0;
    const argvOf = async (over) => {
      let argv = null;
      leadSeq += 1;
      const res = await dispatchRun({
        agentId: "researcher", prompt: "t",
        registryPath, runDir: join(dir, "runs"), runId: `run_${Math.random().toString(36).slice(2, 8)}`,
        // 每次调用独立 leadSession：假 spawn 不写转录，同身份连发会被 busy 门
        // 拒（transcript missing + entry recent ⇒ in-flight）——这不是本测试的主题。
        leadSession: `stable-lead-session-${leadSeq}`, cwd: dir,
        spawnFn: (...a) => { argv = a[1]; return { pid: 1, unref() {}, on() {} }; },
        runnerPath: join(dir, "fake-runner.mjs"),
        ...over,
      });
      return { argv, res };
    };
    // ① 别名 researcher + resolvedRoleId=researcher → 复用路由进（角色政策）
    const alias = await argvOf({ resolvedRoleId: "researcher" });
    assert.equal(alias.res.providerSessionRouting !== "not_used" || alias.argv.includes("--session-reuse-json"), true,
      "角色政策 lead_workspace → 复用路由进入");
    // ② explicit（lane/role 在场）同角色 → 0052 洞②修订：进复用路由（生效政策
    // =分级开关本体；护栏在 resolveReuseTurn——失败即弃/epoch/fresh）。旧钉
    // （0045 洞②"explicit 永不进"）随 0052 修订反转。
    const explicit = await argvOf({ resolvedLane: "x-lane", resolvedRole: "researcher", resolvedRoleId: "researcher" });
    assert.equal(explicit.res.providerSessionRouting !== "not_used" || explicit.argv.includes("--session-reuse-json"), true,
      "0052：explicit 派发 × 角色政策 lead_workspace → 复用路由进入（roles.json=真实开关）");
    // 0052 P0-2：角色指纹必须取【本次派发的角色】正文（旧公式取席位 systemPrompt，
    // 席位无 systemPrompt ⇒ 恒 "none" ⇒ 同车道换帽共用会话——红队实证的缺陷）。
    {
      const { loadRoleContract, roleContractSha256 } = await import("../../src/application/roleContract.js");
      const matIdx = explicit.argv.indexOf("--reuse-material-json");
      assert.ok(matIdx >= 0, "材料件在场");
      const material = JSON.parse(explicit.argv[matIdx + 1]);
      assert.equal(material.roleSha256, roleContractSha256(loadRoleContract("config/roles/researcher.md")),
        "roleSha256 = 本次派发角色正文的 sha（非席位字段、非恒 none）");
    }
    // ②b explicit 换帽（角色无政策）→ 不进（分级：coder/tester/auditor 未入表）
    const explicitNoPolicy = await argvOf({ resolvedLane: "x-lane", resolvedRole: "coder", resolvedRoleId: "coder" });
    assert.equal(explicitNoPolicy.res.providerSessionRouting, "not_used",
      "0052 分级：角色未登记政策 → explicit 也不进（auditor/tester/coder 暂不在册）");
    // ③ 无 resolvedRoleId（legacy 调用，席位无字段）→ 不进复用
    const legacy = await argvOf({});
    assert.equal(legacy.res.providerSessionRouting, "not_used", "无角色无席位政策 → 不复用");
  } finally { cleanupDir(dir); }
});
