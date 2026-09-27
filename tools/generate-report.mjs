#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";

const INPUT_FILE = resolve(process.argv[2] || "test-results.json");
const OUTPUT_FILE = resolve(process.argv[3] || "test-report.html");

async function main() {
  let raw;
  try {
    raw = await readFile(INPUT_FILE, "utf8");
  } catch {
    console.error(`Cannot read ${INPUT_FILE}. Run tests first: npm run test:report`);
    process.exit(1);
  }

  const data = adaptForRender(JSON.parse(raw));

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Test Report</title>
<style>
:root {
  --bg: #1a1b2e; --surface: #222340; --surface-alt: #2a2b48;
  --border: #2d2e4a; --text: #e2e4f0; --text-dim: #8b8da8;
  --accent: #6c8cff; --pass: #4ade80; --fail: #f87171; --skip: #6b7280;
  --diff-removed-bg: rgba(248,113,113,0.12); --diff-added-bg: rgba(74,222,128,0.12);
  --progress-bg: #2d2e4a;
}
*{margin:0;padding:0;box-sizing:border-box}
body{
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  background:var(--bg);color:var(--text);height:100vh;
  display:flex;flex-direction:column;overflow:hidden;
}
.summary-bar{
  background:var(--surface);border-bottom:1px solid var(--border);
  padding:16px 24px;display:flex;align-items:center;gap:20px;flex-shrink:0;
}
.summary-bar h1{font-size:16px;font-weight:600}
.summary-bar .counts{display:flex;gap:12px;font-size:13px}
.summary-bar .counts span{display:flex;align-items:center;gap:4px}
.count-pass{color:var(--pass)}
.count-fail{color:var(--fail)}
.count-skip{color:var(--skip)}
.progress-container{flex:1;max-width:300px}
.progress-bar{height:6px;background:var(--progress-bg);border-radius:3px;overflow:hidden}
.progress-fill{height:100%;background:linear-gradient(90deg,var(--pass),var(--accent));border-radius:3px;transition:width .3s}
.progress-label{font-size:11px;color:var(--text-dim);margin-top:2px}
.main{display:flex;flex:1;overflow:hidden}
.sidebar{
  width:280px;background:var(--surface);border-right:1px solid var(--border);
  display:flex;flex-direction:column;flex-shrink:0;
}
.sidebar-header{padding:12px 16px;border-bottom:1px solid var(--border)}
.sidebar-header input{
  width:100%;padding:8px 12px;border-radius:6px;border:1px solid var(--border);
  background:var(--bg);color:var(--text);font-size:13px;outline:none;
}
.sidebar-header input:focus{border-color:var(--accent)}
.sidebar-header input::placeholder{color:var(--text-dim)}
.file-tree{flex:1;overflow-y:auto;padding:8px 0}
.tree-item{
  display:flex;align-items:center;gap:8px;padding:6px 16px;cursor:pointer;
  font-size:13px;transition:background .15s;border:none;background:none;
  color:var(--text);width:100%;text-align:left;
}
.tree-item:hover{background:var(--surface-alt)}
.tree-item.active{background:rgba(108,140,255,0.1);border-left:3px solid var(--accent)}
.tree-item .icon{width:16px;text-align:center;flex-shrink:0}
.tree-item .icon.pass{color:var(--pass)}
.tree-item .icon.fail{color:var(--fail)}
.tree-item .icon.skip{color:var(--skip)}
.tree-item .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tree-dir{font-weight:600}
.tree-dir .dir-arrow{transition:transform .15s;display:inline-block}
.tree-dir .dir-arrow.collapsed{transform:rotate(-90deg)}
.tree-children{padding-left:20px}
.tree-children.hidden{display:none}
.content{flex:1;overflow-y:auto;padding:24px}
.content-empty{display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-dim);font-size:15px}
.suite-header{margin-bottom:20px}
.suite-header h2{font-size:18px;font-weight:600;margin-bottom:4px}
.suite-header .meta{font-size:13px;color:var(--text-dim);display:flex;gap:12px}
.test-list{display:flex;flex-direction:column;gap:2px}
.test-row{
  display:flex;align-items:flex-start;gap:10px;padding:10px 14px;
  border-radius:6px;transition:background .15s;
}
.test-row:hover{background:var(--surface-alt)}
.test-row .status-icon{font-size:14px;margin-top:1px;flex-shrink:0}
.test-row .test-name{font-size:14px;flex:1}
.test-row .test-duration{font-size:12px;color:var(--text-dim);flex-shrink:0}
.test-row.pass .status-icon{color:var(--pass)}
.test-row.fail{cursor:pointer}
.test-row.fail .status-icon{color:var(--fail)}
.test-row.skip .status-icon{color:var(--skip)}
.test-row.skip .test-name{color:var(--text-dim)}
.diff-box{
  margin:8px 0 4px 40px;padding:12px 16px;
  background:var(--bg);border-radius:6px;border:1px solid var(--border);
  font-family:"SF Mono","Fira Code","Consolas",monospace;
  font-size:13px;line-height:1.5;overflow-x:auto;white-space:pre;
}
.diff-box .diff-removed{background:var(--diff-removed-bg)}
.diff-box .diff-added{background:var(--diff-added-bg)}
.diff-box .diff-hunk{color:var(--text-dim);font-style:italic}
.error-stack{
  margin:4px 0 4px 40px;padding:8px 16px;
  font-family:"SF Mono","Fira Code","Consolas",monospace;
  font-size:12px;color:var(--text-dim);white-space:pre-wrap;
  max-height:200px;overflow-y:auto;
}
.footer-bar{
  background:var(--surface);border-top:1px solid var(--border);
  padding:10px 24px;font-size:13px;color:var(--text-dim);
  display:flex;gap:20px;flex-shrink:0;
}
.filter-highlight{background:rgba(108,140,255,0.2);border-radius:2px}
</style>
</head>
<body>
<div class="summary-bar">
  <h1>Test Report</h1>
  <span class="counts">
    ${data.canonical ? `<span class="${data.canonicalOverallPass ? "count-pass" : "count-fail"}">${data.canonicalOverallPass ? "\u2714" : "\u2716"} canonical overall: ${data.canonicalOverallPass ? "PASS" : "FAIL"}</span><span class="count-skip">runner verdict: ${data.canonicalVerdictLabel}</span>` : ""}
    <span class="count-pass">\u2714 ${data.summary.passed}${data.canonical ? ` file${data.summary.passed === 1 ? "" : "s"} passed` : " passed"}</span>
    ${data.summary.failed > 0 ? `<span class="count-fail">\u2716 ${data.summary.failed}${data.canonical ? ` file${data.summary.failed === 1 ? "" : "s"} failed` : " failed"}</span>` : ""}
    ${data.summary.skipped > 0 ? `<span class="count-skip">\u2014 ${data.summary.skipped} skipped</span>` : ""}
  </span>
  <div class="progress-container">
    <div class="progress-bar">
      <div class="progress-fill" style="width:${data.summary.total > 0 ? (data.summary.passed / data.summary.total * 100) : (data.canonical ? 0 : 100)}%"></div>
    </div>
    <div class="progress-label">${data.summary.passed}/${data.summary.total} ${data.canonical ? "files" : "tests"} passing</div>
  </div>
</div>
<div class="main">
  <div class="sidebar">
    <div class="sidebar-header">
      <input type="text" id="filter" placeholder="Filter tests..." oninput="filterTests(this.value)">
    </div>
    <div class="file-tree" id="fileTree"></div>
  </div>
  <div class="content" id="content">
    <div class="content-empty">Select a file to view results</div>
  </div>
</div>
<div class="footer-bar">
  <span>Pass: <span class="count-pass">${data.summary.passed}</span></span>
  <span>Fail: <span class="count-fail">${data.summary.failed}</span></span>
  <span>Skip: <span class="count-skip">${data.summary.skipped}</span></span>
  <span>Duration: ${formatDuration(data.duration)}</span>
</div>
<script id="test-data" type="application/json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>
<script>${buildScriptSource()}</script>
</body>
</html>`;

  await mkdir(dirname(OUTPUT_FILE), { recursive: true });
  await writeFile(OUTPUT_FILE, html, "utf8");
  console.log(`Report written to ${OUTPUT_FILE}`);
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m${s}s`;
}

// ── TD-181 (a) consumer-side compatibility ───────────────────────────────────
// `npm test` (canonical runner) overwrites test-results.json with its OWN
// aggregate schema (schemaVersion 4: executionWaves/firstRound/isolation…),
// which previously made this tool crash (no data.summary). Projection below is
// ADDITIVE compatibility + failure-detail rendering only:
//   - a reporter-shaped report ({summary, suites}) passes through UNCHANGED;
//   - a canonical aggregate is projected into the summary/suites view the
//     renderer already consumes, surfacing each first-round failure's retained
//     detail (sub-test names, assertion text, stacks) via the existing error
//     boxes. New canonical fields are ignored here by design — this is not a
//     report platform.
//
// TD-181 (b, 2026-09-26, audit22 fix; r2 rework): the projection must separate
// OVERALL execution failure from the TEST verdict, and must not fake green.
//   - The runner's exit decision (finalRunnerOutcome) is NOT the same as the
//     JSON finalVerdict: runsDirGuard additions/error exit non-zero even when
//     finalVerdict is "pass". suiteError / suiteAborted / wave groupError /
//     guard are therefore evaluated INDEPENDENTLY, and ANY of them (or a
//     non-pass / missing verdict) makes the run OVERALL non-pass. The top bar
//     then shows a red "canonical overall: FAIL" badge — a green PASS badge
//     may never coexist with failure rows — while the runner's own test
//     verdict is listed separately as a neutral, closed-set line.
//   - FILE COUNTS STAY FILE COUNTS. firstRound.passed/failed/missing/crashed
//     count FILES; runner-level diagnostics are rendered as their own visible
//     rows but are NOT folded into the passed/failed denominators (the r1
//     projection rendered the real 243/246 aggregate as "243/247, 4 failed").
//   - SECURITY: the embedded JSON payload escapes every "<" as the JSON escape
//     sequence backslash-u-0-0-3-c so report
//     content (failureDetail, groupError, guard errors…) can never terminate
//     the script element early; badge labels come from a CLOSED verdict label
//     set — raw verdict strings never enter server-rendered HTML. Report
//     content still round-trips losslessly: < parses back to "<".
function detailError(d) {
  return {
    actual: d.actual ?? "",
    expected: d.expected ?? "",
    operator: d.operator ?? "fail",
    stack: d.stack ?? "",
    diff: d.diff ?? null,
  };
}

function canonicalSuites(data) {
  const isolationByPath = new Map();
  for (const iso of (Array.isArray(data.isolation) ? data.isolation : [])) {
    if (iso && typeof iso.path === "string") isolationByPath.set(iso.path, iso);
  }
  const suites = [];
  for (const wave of (Array.isArray(data.executionWaves) ? data.executionWaves : [])) {
    if (!wave || !Array.isArray(wave.files)) continue;
    for (const f of wave.files) {
      if (!f || typeof f.path !== "string") continue;
      const status = f.status === "pass" ? "pass" : "fail"; // missing/crash render as fail (they are non-pass)
      const tests = [];
      if (status === "fail") {
        const failure = (data.firstRound && Array.isArray(data.firstRound.failures))
          ? data.firstRound.failures.find((x) => x && x.path === f.path) : null;
        const d = failure && failure.failureDetail;
        if (d && d.status === "collected") {
          for (const t of (Array.isArray(d.failingTests) ? d.failingTests : [])) {
            tests.push({ name: t.name ?? "(unnamed)", status: "fail", duration: 0, error: detailError(t) });
          }
          if (d.fileFailure && (d.fileFailure.message || d.fileFailure.stack)) {
            tests.push({
              name: `fileFailure: ${d.fileFailure.message ?? ""}`,
              status: "fail", duration: 0,
              error: { actual: "", expected: "", operator: "fail", stack: d.fileFailure.stack ?? "", diff: null },
            });
          }
          if (d.failingTestsDropped > 0) {
            tests.push({ name: `… ${d.failingTestsDropped} more failing test(s) truncated in the bounded report`, status: "skip", duration: 0 });
          }
          // TD-181 (b) r2: an explicitly dropped fileFailure must be SHOWN as a
          // budget omission (same honesty as failingTestsDropped) — a skip row,
          // never counted as a test/failure.
          if (d.fileFailureDropped === true) {
            tests.push({ name: "fileFailure content omitted — dropped to fit the per-file char budget (fileFailureDropped)", status: "skip", duration: 0 });
          }
        } else {
          tests.push({
            name: `first-round ${f.status} — failure detail ${d && d.status === "unknown" ? "unknown" : "not collected"}${d && d.reason ? ` (${d.reason})` : ""}`,
            status: "fail", duration: 0,
          });
        }
      }
      const iso = isolationByPath.get(f.path);
      if (iso) {
        tests.push({
          name: `isolation rerun: alone=${iso.isolationStatus} ⇒ ${iso.classification}${iso.isolationDurationMs != null ? ` (${formatDuration(iso.isolationDurationMs)})` : ""}`,
          status: iso.classification === "isolation_pass" ? "skip" : "fail",
          duration: 0,
        });
      }
      suites.push({ name: `test/${f.path}`, status, duration: f.durationMs ?? 0, tests });
    }
  }
  return suites;
}

// Closed label set for the runner's test verdict — the ONLY values the
// server-rendered badge/verdict line may interpolate (an unknown or hostile
// verdict string degrades to "unknown" here; its raw value is still preserved
// losslessly inside the escaped JSON payload for the client to render via esc()).
const CANONICAL_VERDICT_LABELS = Object.freeze({ pass: "pass", fail: "fail", environment_invalid: "environment_invalid" });
function canonicalVerdictLabelOf(verdict) {
  return typeof verdict === "string" && Object.prototype.hasOwnProperty.call(CANONICAL_VERDICT_LABELS, verdict)
    ? CANONICAL_VERDICT_LABELS[verdict] : "unknown";
}

function adaptForRender(data) {
  if (!data || typeof data !== "object") return data;
  if (!data.executionWaves && !data.firstRound) {
    // failInvalidEnvironment's minimal report (no waves, no firstRound): render
    // its error as one visible failed suite instead of crashing on summary.
    // TD-181 (b) r2: zero files ran — the file counts stay an honest 0/0 and the
    // progress bar stays empty; overall failure is carried by the red badge and
    // the visible row, not by folding the diagnostic row into file counts.
    if (data.finalVerdict === "environment_invalid") {
      return {
        canonical: true,
        canonicalVerdict: "environment_invalid",
        canonicalVerdictLabel: "environment_invalid",
        canonicalOverallPass: false,
        summary: { total: 0, passed: 0, failed: 0, skipped: 0 },
        duration: 0,
        suites: [{
          name: "canonical-runner/environment_invalid",
          status: "fail",
          duration: 0,
          tests: [{
            name: `environment_invalid (no tests run): ${typeof data.error === "string" ? data.error : "(no error message)"}`,
            status: "fail", duration: 0,
            error: { actual: "", expected: "", operator: "fail", stack: "", diff: null },
          }],
        }],
      };
    }
    return data; // reporter shape: unchanged
  }
  const fr = data.firstRound || {};
  const num = (v) => (Number.isFinite(v) ? v : 0);
  const suites = canonicalSuites(data);
  const suiteLevel = canonicalSuiteLevelRows(data);
  if (suiteLevel.length > 0) {
    // Runner-level diagnostics render as their own visible suite (each row
    // individually attributable) but are NEVER folded into the file counts —
    // summary below stays a pure firstRound FILE tally.
    suites.push({
      name: "canonical/overall-verdict",
      status: "fail",
      duration: 0,
      tests: suiteLevel.map((name) => ({ name, status: "fail", duration: 0 })),
    });
  }
  return {
    canonical: true,
    canonicalVerdict: (typeof data.finalVerdict === "string" && data.finalVerdict) || "missing",
    canonicalVerdictLabel: canonicalVerdictLabelOf(data.finalVerdict),
    // overall pass ⇔ NO failure signal at all (verdict pass AND no suiteError
    // AND no abort AND no wave groupError AND no guard additions AND no guard
    // error) — canonicalSuiteLevelRows returns [] exactly in that state.
    canonicalOverallPass: suiteLevel.length === 0,
    summary: {
      total: num(fr.passed) + num(fr.failed) + num(fr.missing) + num(fr.crashed),
      passed: num(fr.passed),
      failed: num(fr.failed) + num(fr.missing) + num(fr.crashed),
      skipped: 0,
    },
    duration: data.totalDurationMs ?? 0,
    suites,
  };
}

// TD-181 (b) r2: suite-level non-pass rows for a canonical aggregate — the
// causes that never appear as a failing FILE but decide the runner's EXIT.
// Returns [] exactly when nothing suite-level is wrong (a clean pass renders no
// synthetic suite). Every signal is evaluated INDEPENDENTLY of finalVerdict:
// finalRunnerOutcome exits non-zero on runs-guard additions/error even when the
// JSON verdict is "pass". Row texts are plain statements of the report's own
// fields; long groupError text is cut with an explicit truncation marker, never
// rewritten. Rows live only inside the escaped JSON payload (rendered by the
// client via esc()) — none of this text is interpolated into server HTML.
function canonicalSuiteLevelRows(data) {
  const num = (v) => (Number.isFinite(v) ? v : 0);
  const fr = data.firstRound || {};
  const guard = data.runsDirGuard && typeof data.runsDirGuard === "object" ? data.runsDirGuard : {};
  const guardAdds = Array.isArray(guard.additions) ? guard.additions : [];
  const waveErrors = [];
  for (const wave of (Array.isArray(data.executionWaves) ? data.executionWaves : [])) {
    if (wave && typeof wave.groupError === "string" && wave.groupError) {
      waveErrors.push({ name: typeof wave.name === "string" ? wave.name : "?", groupError: wave.groupError });
    }
  }
  const verdict = (typeof data.finalVerdict === "string" && data.finalVerdict) || null;
  const verdictNonPass = verdict !== "pass"; // missing verdict is fail-visible too
  if (!verdictNonPass && waveErrors.length === 0 && !data.suiteError && !data.suiteAborted
    && guardAdds.length === 0 && !guard.error) {
    return [];
  }
  const rows = [];
  const causes = [`canonical overall: FAIL — the run did not pass`];
  if (verdict === null) {
    causes.push("finalVerdict missing from the report");
  } else if (verdict !== "pass") {
    causes.push(`runner test verdict: ${canonicalVerdictLabelOf(verdict)} (raw field: ${JSON.stringify(verdict)})`);
    const nonPass = num(fr.failed) + num(fr.missing) + num(fr.crashed);
    if (nonPass > 0) {
      causes.push(`first-round non-pass files: ${num(fr.failed)} failed / ${num(fr.missing)} missing / ${num(fr.crashed)} crashed`);
    }
  } else {
    // verdict pass but a runner-level failure exists — finalRunnerOutcome still
    // exits non-zero; state the discrepancy instead of letting counts imply pass.
    causes.push("runner test verdict says pass, but the runner still exited non-zero on a runner-level failure");
  }
  if (data.suiteError) causes.push("suiteError: at least one wave-level error (groupError)");
  if (data.suiteAborted) causes.push(`suite aborted (origin: ${typeof data.abortOrigin === "string" ? data.abortOrigin : "unknown"}) — waves/isolation after the abort point did NOT run`);
  if (guardAdds.length > 0) causes.push(`runs-guard: ${guardAdds.length} new entries in the REAL runs/ during the suite (non-zero exit even when every test passed)`);
  if (guard.error) causes.push(`runs-guard could not observe runs/ (${guard.error})`);
  rows.push(causes.join(" — "));
  for (const w of waveErrors) {
    rows.push(`wave '${w.name}' error: ${boundRenderText(w.groupError, 500)}`);
  }
  for (const a of guardAdds) {
    rows.push(`runs-guard: runs/${typeof a?.file === "string" ? a.file : "?"} (first seen: ${typeof a?.phase === "string" ? a.phase : "?"})`);
  }
  if (guard.error) rows.push(`runs-guard observation error: ${boundRenderText(String(guard.error), 500)}`);
  return rows;
}

// Render-side bounded text: cut with an explicit marker carrying shown/total.
function boundRenderText(value, cap) {
  if (typeof value !== "string") return "";
  if (value.length <= cap) return value;
  return value.slice(0, cap) + `…[TRUNCATED: first ${cap} of ${value.length} chars]`;
}

function buildScriptSource() {
  return `
(function(){var data=JSON.parse(document.getElementById("test-data").textContent);
var sel=null,ft="";
function esc(s){return s.replace(/&/g,"&amp;").replace(/'/g,"&#39;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}
function renderTree(){document.getElementById("fileTree").innerHTML=buildNodes(data.suites)}
function buildNodes(suites){var tree={};
for(var i=0;i<suites.length;i++){var s=suites[i];var pts=s.name.replace(/\\\\/g,"/").split("/");var n=tree;
for(var j=0;j<pts.length-1;j++){if(!n[pts[j]]) n[pts[j]]={};n=n[pts[j]]}
if(!n.__f__) n.__f__=[];n.__f__.push(s)}
return renderNode(tree,"")}
function renderNode(n,pfx){var h="";var ds=Object.keys(n).filter(function(k){return k!=="__f__"}).sort();
for(var i=0;i<ds.length;i++){var d=ds[i];
h+='<div class="tree-children"><div class="tree-item tree-dir" data-dir="1"><span class="dir-arrow">\\u25bc</span> '+esc(d)+'</div>';
h+=renderNode(n[d],pfx?pfx+"/"+d:d);h+='</div>'}
if(n.__f__){var sl=n.__f__.slice().sort(function(a,b){return a.name.localeCompare(b.name)});
for(var j=0;j<sl.length;j++){var su=sl[j];var fn=su.name.split("/").pop();
var ic=su.status==="pass"?"\\u2714":su.status==="fail"?"\\u2716":"\\u2014";
h+='<button class="tree-item" data-suite="'+esc(su.name)+'"><span class="icon '+su.status+'">'+ic+'</span><span class="name">'+esc(fn)+'</span></button>'}}
return h}
function selectSuite(sn){sel=sn;
document.querySelectorAll(".tree-item.active").forEach(function(e){e.classList.remove("active")});
var btn=document.querySelector('[data-suite="'+esc(sn)+'"]');
if(btn)btn.classList.add("active");renderDetail(sn)}
function renderDetail(sn){var su;for(var i=0;i<data.suites.length;i++){if(data.suites[i].name===sn){su=data.suites[i];break}}
if(!su)return;var con=document.getElementById("content");var unit=data.canonical?'report entries':'tests';var h='<div class="suite-header"><h2>'+esc(su.name)+'</h2><div class="meta"><span>'+su.tests.length+' '+unit+'</span><span>'+su.duration.toFixed(0)+'ms</span></div></div><div class="test-list">';
var tts=su.tests;if(ft){var lc=ft.toLowerCase();tts=su.tests.filter(function(t){return t.name.toLowerCase().indexOf(lc)!==-1})}
if(tts.length===0&&ft){h+='<div style="color:var(--text-dim);padding:20px;text-align:center">No '+unit+' match "'+esc(ft)+'"</div>'}
for(var j=0;j<tts.length;j++){var t=tts[j];var ic=t.status==="pass"?"\\u2714":t.status==="fail"?"\\u2716":"\\u2014";
h+='<div class="test-row '+t.status+'"'+(t.status==="fail"?' data-fail="1"':'')+'>';
h+='<span class="status-icon">'+ic+'</span><span class="test-name">'+esc(t.name)+'</span><span class="test-duration">'+t.duration.toFixed(0)+'ms</span></div>';
if(t.status==="fail"&&t.error){h+='<div class="diff-box" style="display:none">';
if(t.error.diff){var ln=t.error.diff.split("\\\\n");
for(var k=0;k<ln.length;k++){var l=ln[k];
if(l[0]==="-"&&l[1]===" ")h+='<div class="diff-removed">'+esc(l)+'</div>';
else if(l[0]==="+"&&l[1]===" ")h+='<div class="diff-added">'+esc(l)+'</div>';
else if(l.indexOf("@@")===0)h+='<div class="diff-hunk">'+esc(l)+'</div>';
else h+='<div>'+esc(l)+'</div>'}}else{h+='<div>Actual: '+esc(t.error.actual)+'</div><div>Expected: '+esc(t.error.expected)+'</div>'}
if(t.error.stack){h+='</div><div class="error-stack" style="display:none">'+esc(t.error.stack)+'</div>'}
h+='</div>'}}h+='</div>';con.innerHTML=h}
document.getElementById("fileTree").addEventListener("click",function(e){
var d=e.target.closest(".tree-dir[data-dir]");if(d){var n=d.nextElementSibling;if(n&&n.classList.contains("tree-children")){
var h=n.classList.toggle("hidden");d.querySelector(".dir-arrow").classList.toggle("collapsed",h)}return}
var b=e.target.closest(".tree-item[data-suite]");if(b){var n=b.getAttribute("data-suite");selectSuite(n);history.replaceState(null,"","#"+n)}});
document.getElementById("content").addEventListener("click",function(e){
var r=e.target.closest(".test-row[data-fail]");if(!r)return;
var db=r.nextElementSibling;var sb=db?db.nextElementSibling:null;
if(db&&db.classList.contains("diff-box")){var h=db.style.display==="none"||!db.style.display;db.style.display=h?"block":"none";
if(sb&&sb.classList.contains("error-stack"))sb.style.display=h?"block":"none"}});
document.getElementById("filter").addEventListener("input",function(){ft=this.value;if(sel)renderDetail(sel)});
window.addEventListener("hashchange",function(){var h=location.hash.slice(1);if(h)selectSuite(h)});
renderTree();var h=location.hash.slice(1);if(h)selectSuite(h);else if(data.suites.length>0)selectSuite(data.suites[0].name);
})();
`;
}

main().catch((err) => { console.error(err.message); process.exit(1); });
