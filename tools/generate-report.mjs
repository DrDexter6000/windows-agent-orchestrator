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

  const data = JSON.parse(raw);

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
    <span class="count-pass">\u2714 ${data.summary.passed} passed</span>
    ${data.summary.failed > 0 ? `<span class="count-fail">\u2716 ${data.summary.failed} failed</span>` : ""}
    ${data.summary.skipped > 0 ? `<span class="count-skip">\u2014 ${data.summary.skipped} skipped</span>` : ""}
  </span>
  <div class="progress-container">
    <div class="progress-bar">
      <div class="progress-fill" style="width:${data.summary.total > 0 ? (data.summary.passed / data.summary.total * 100) : 100}%"></div>
    </div>
    <div class="progress-label">${data.summary.passed}/${data.summary.total} tests passing</div>
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
<script id="test-data" type="application/json">${JSON.stringify(data)}</script>
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
if(!su)return;var con=document.getElementById("content");var h='<div class="suite-header"><h2>'+esc(su.name)+'</h2><div class="meta"><span>'+su.tests.length+' tests</span><span>'+su.duration.toFixed(0)+'ms</span></div></div><div class="test-list">';
var tts=su.tests;if(ft){var lc=ft.toLowerCase();tts=su.tests.filter(function(t){return t.name.toLowerCase().indexOf(lc)!==-1})}
if(tts.length===0&&ft){h+='<div style="color:var(--text-dim);padding:20px;text-align:center">No tests match "'+esc(ft)+'"</div>'}
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
