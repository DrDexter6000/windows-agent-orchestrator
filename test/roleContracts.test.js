// Batch 1A — Worker role contracts contain no orchestration.
//
// Role files define identity, scope, boundaries, and discipline only.
// No role file instructs a worker to call WAO, write decision/handoff/state/stage
// artifacts, or use injected orchestration environment variables.
//
// Chief-Auditor is explicitly the Lead Agent's peer collaborator.
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const ROLES_DIR = join(REPO, "config", "roles");

const ORCHESTRATION_MARKERS = [
  "$WAO_CLI",
  "WAO_TARGET_CWD",
  "wao handoff",
  "wao decision",
  "wao stage",
];

async function readRoleFiles() {
  const names = await readdir(ROLES_DIR);
  const mdNames = names.filter((n) => n.endsWith(".md")).sort();
  const entries = await Promise.all(
    mdNames.map(async (n) => ({ name: n, content: await readFile(join(ROLES_DIR, n), "utf8") })),
  );
  return entries;
}

// ---------------------------------------------------------------------------
// 1. No role file may contain orchestration markers
// ---------------------------------------------------------------------------
test("1A: no role file contains orchestration markers ($WAO_CLI / WAO_TARGET_CWD / wao handoff / wao decision / wao stage)", async () => {
  const files = await readRoleFiles();
  assert.ok(files.length >= 6, `expected at least 6 role files, got ${files.length}`);
  const violations = [];
  for (const { name, content } of files) {
    for (const marker of ORCHESTRATION_MARKERS) {
      if (content.includes(marker)) {
        violations.push({ file: name, marker });
      }
    }
  }
  assert.deepEqual(violations, [], `orchestration markers found in role files: ${JSON.stringify(violations)}`);
});

// ---------------------------------------------------------------------------
// 2. Each role file retains scope / boundary / discipline sections
// ---------------------------------------------------------------------------
test("1A: each role file has scope, boundary, and discipline sections", async () => {
  const files = await readRoleFiles();
  const scopeRe = /scope|做什么/i;
  const boundaryRe = /边界|boundary|不做什么/i;
  const disciplineRe = /纪律|discipline/i;
  const missing = [];
  for (const { name, content } of files) {
    if (!scopeRe.test(content)) missing.push(`${name}: scope`);
    if (!boundaryRe.test(content)) missing.push(`${name}: boundary`);
    if (!disciplineRe.test(content)) missing.push(`${name}: discipline`);
  }
  assert.deepEqual(missing, [], `role files missing sections: ${missing.join(", ")}`);
});

// ---------------------------------------------------------------------------
// 3. auditor.md must contain "Lead Agent" and peer-collaborator meaning
// ---------------------------------------------------------------------------
test("1A: auditor.md names Lead Agent as peer collaborator", async () => {
  const content = await readFile(join(ROLES_DIR, "auditor.md"), "utf8");
  assert.ok(/Lead Agent/i.test(content), "auditor.md must reference Lead Agent");
  assert.ok(/平级.*合作|peer collaborator/i.test(content), "auditor.md must express peer collaborator of Lead Agent");
});

// ---------------------------------------------------------------------------
// 4. auditor.md must NOT call Chief-Auditor a CTO peer
// ---------------------------------------------------------------------------
test("1A: auditor.md does not claim to be CTO's peer", async () => {
  const content = await readFile(join(ROLES_DIR, "auditor.md"), "utf8");
  assert.ok(!/CTO.*平级|平级.*CTO/i.test(content), "auditor.md must not call itself CTO's peer");
});

// ---------------------------------------------------------------------------
// 5. auditor.md expresses the full Chief-Auditor contract
// ---------------------------------------------------------------------------
test("1A: auditor.md expresses independence, non-decision, alternatives, proportional context, no-unauthorized-edits", async () => {
  const content = await readFile(join(ROLES_DIR, "auditor.md"), "utf8");
  // independent, evidence-led, non-sycophantic
  assert.ok(/独立|independent/i.test(content), "must express independence");
  assert.ok(/证据|evidence/i.test(content), "must express evidence-led");
  assert.ok(/不迎合|不奉承|non-sycophantic/i.test(content), "must express non-sycophantic");
  // does not implement or make final decision
  assert.ok(/不.*实现|不.*implement|不.*拍板|不.*最终决策|does not (?:implement|decide)/i.test(content),
    "must express does not implement or decide");
  // may propose verifiable alternative directions
  assert.ok(/替代方向|alternative direction|建设性/i.test(content),
    "must express may propose alternative directions");
  // context proportional to risk, not unlimited
  assert.ok(/风险.*上下文|上下文.*风险|proportional|相称|不.*无界|不.*尽可能完整/i.test(content),
    "must express context proportional to risk");
  // does not mutate files unless task-authorized
  assert.ok(/不.*修改.*文件|未.*授权.*不.*改|does not mutate|not.*authorized.*edit/i.test(content),
    "must express no unauthorized file mutation");
});
