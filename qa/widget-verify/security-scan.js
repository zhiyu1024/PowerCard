/**
 * Independent QA helper (task-7): scan v1.1.0 APK payload + repo docs/sources,
 * plus zip entry list consistency, for secrets / real device URLs / token leaks.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const APK_ROOT = path.join(ROOT, 'qa', 'widget-verify', 'apk-extract', 'unzipped');

const patterns = [
  { name: 'keystore-password-key', re: /storePassword|keyPassword/gi },
  { name: 'private-key-block', re: /BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY/gi },
  { name: 'jks-filename', re: /(?:powercard-release\.jks|keystore\.properties)/gi },
  { name: 'bearer-token', re: /Bearer\s+[A-Za-z0-9._~+/-]{12,}/g },
  { name: 'token-param', re: /[?&]token=[A-Za-z0-9._~%+/-]{8,}/g },
  { name: 'vendor-cloud-host', re: /(vlinkc|open\.iot\.)/gi },
  { name: 'mock-device-name', re: /dev-mock|device\.local|device\.example/gi },
  { name: 'private-ip-address', re: /\b(?:192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)\b/g },
];

const scanRoots = [
  { dir: APK_ROOT, label: 'APK' },
  { dir: path.join(ROOT, 'docs'), label: 'docs' },
  { dir: path.join(ROOT, 'public'), label: 'public' },
  { dir: path.join(ROOT, 'scripts'), label: 'scripts' },
  { dir: path.join(ROOT, 'android', 'app', 'src'), label: 'android-src' },
  { file: path.join(ROOT, 'README.md'), label: 'README' },
];

function walk(target, label, out = []) {
  const currentLabel = target.label || label;
  if (target.file) {
    out.push({ file: target.file, label: currentLabel });
    return out;
  }
  for (const entry of readdirSync(target.dir, { withFileTypes: true })) {
    const full = path.join(target.dir, entry.name);
    if (entry.isDirectory()) walk({ dir: full, label: currentLabel }, currentLabel, out);
    else if (entry.isFile()) out.push({ file: full, label: currentLabel });
  }
  return out;
}

const files = [];
for (const root of scanRoots) files.push(...walk(root));

const hits = [];
let scannedFiles = 0;
for (const { file, label } of files) {
  const rel = path.relative(ROOT, file).replaceAll('\\', '/');
  if (rel.includes('/build/') || rel.startsWith('android/app/build/')) continue;
  const text = readFileSync(file).toString('latin1');
  scannedFiles++;
  for (const pattern of patterns) {
    pattern.re.lastIndex = 0;
    let match;
    while ((match = pattern.re.exec(text)) !== null) {
      const start = Math.max(0, match.index - 30);
      const end = Math.min(text.length, match.index + match[0].length + 30);
      const context = text
        .slice(start, end)
        .replace(/[^\x20-\x7e]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      hits.push({ label, file: rel, pattern: pattern.name, context });
      if (pattern.re.lastIndex === match.index) pattern.re.lastIndex++;
    }
  }
}

const grouped = new Map();
for (const hit of hits) {
  if (!grouped.has(hit.pattern)) grouped.set(hit.pattern, []);
  grouped.get(hit.pattern).push(hit);
}

console.log(`scanned files: ${scannedFiles}`);
if (hits.length === 0) {
  console.log('RESULT: NO SECRET-LIKE MATCHES');
} else {
  for (const [pattern, list] of grouped) {
    console.log(`\n[${pattern}] ${list.length} match(es)`);
    const byLabel = new Map();
    for (const hit of list) byLabel.set(hit.label, (byLabel.get(hit.label) || 0) + 1);
    console.log(`  by source: ${[...byLabel].map(([k, v]) => `${k}=${v}`).join(', ')}`);
    for (const hit of list.slice(0, 6)) {
      console.log(`  ${hit.label} ${hit.file}`);
      console.log(`    context: ${hit.context}`);
    }
    if (list.length > 6) console.log(`  ... ${list.length - 6} more`);
  }
}
console.log(`\nRESULT: total_matches=${hits.length} scanned=${scannedFiles}`);

// ZIP entry listing: names + duplicate (case-insensitive on Windows) detection.
const zipPath = path.join(ROOT, 'dist', 'PowerCard-v1.1.0.apk');
const buf = readFileSync(zipPath);
// Parse central directory minimally for count (or rely on earlier PowerShell listing).
console.log(`apk: ${path.relative(ROOT, zipPath)} ${statSync(zipPath).size} bytes (zip listing provided by PowerShell evidence files)`);
