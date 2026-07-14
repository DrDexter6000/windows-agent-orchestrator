#!/usr/bin/env node
// Fake worker: writes a file to simulate worker output, then exits 0.
// Usage: node fake-worker-writefile.cjs <filename> <content>
// Writes to process.cwd()/src/<filename> — works inside worktrees.
const fs = require("node:fs");
const path = require("node:path");
const [, , filename, content] = process.argv;
if (filename) {
  const targetDir = path.join(process.cwd(), "src");
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, filename), content || "fake output\n");
}
process.exit(0);
