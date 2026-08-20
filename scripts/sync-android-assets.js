'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'android', 'app', 'src', 'main', 'assets', 'www');
const entries = ['index.html', 'style.css', 'game.js', 'platform.js', 'native-bridge-android.js', 'ricochet.js', 'daily.js', 'tutorial.js', 'site.webmanifest', 'assets'];
const excludedDirs = new Set(['docs', 'previews', 'source_sheets', 'reference_sheets']);
const excludedExts = new Set(['.md', '.json']);

function copyRecursive(src, dest) {
  const name = path.basename(src);
  if (excludedDirs.has(name) || excludedExts.has(path.extname(name).toLowerCase())) return;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const child of fs.readdirSync(src)) {
      copyRecursive(path.join(src, child), path.join(dest, child));
    }
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const entry of entries) {
  copyRecursive(path.join(root, entry), path.join(out, entry));
}
console.log(`Synced web assets to ${path.relative(root, out)}`);
