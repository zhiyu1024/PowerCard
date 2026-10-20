/**
 * Independent QA helper: scan APK-extracted files and repo docs/sources for
 * secrets (keystore passwords, private keys, bearer tokens, real device URLs).
 *
 * Scope: qa/apk-verify/apk-extract/unzipped (APK payload),
 *        README.md, docs/*.md, scripts/*.ps1|js, public/**, android/app/src/**.
 * Excludes: .git, node_modules, .android-toolchain, qa/artifacts, keystore files
 * (expected local secrets, verified git-ignored separately).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const APK_ROOT = path.join(ROOT, 'qa', 'apk-verify', 'apk-extract', 'unzipped');

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
  const entries = readdirSync(target.dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(target.dir, entry.name);
    if (entry.isDirectory()) {
      walk({ dir: full, label: currentLabel }, currentLabel, out);
    } else if (entry.isFile()) {
      out.push({ file: full, label: currentLabel });
    }
  }
  return out;
}

const files = [];
for (const root of scanRoots) files.push(...walk(root));

const hits = [];
let scannedFiles = 0;
for (const { file, label } of files) {
  // Skip build artifacts that duplicate sources.
  const rel = path.relative(ROOT, file).replaceAll('\\', '/');
  if (rel.includes('/build/') || rel.startsWith('android/app/build/')) continue;
  const buf = readFileSync(file);
  scannedFiles++;
  // latin1 keeps ASCII bytes 1:1; Chinese patterns not needed for secret scan.
  const text = buf.toString('latin1');
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
      hits.push({
        label,
        file: rel,
        pattern: pattern.name,
        match: match[0].length > 120 ? `${match[0].slice(0, 120)}...` : match[0],
        context,
      });
      if (pattern.re.lastIndex === match.index) pattern.re.lastIndex++;
    }
  }
}

const grouped = new Map();
for (const hit of hits) {
  const key = `${hit.pattern}`;
  if (!grouped.has(key)) grouped.set(key, []);
  grouped.get(key).push(hit);
}

console.log(`scanned files: ${scannedFiles}`);
if (hits.length === 0) {
  console.log('RESULT: NO SECRET-LIKE MATCHES');
} else {
  for (const [pattern, list] of grouped) {
    console.log(`\n[${pattern}] ${list.length} match(es)`);
    for (const hit of list.slice(0, 25)) {
      console.log(`  ${hit.label} ${hit.file}`);
      console.log(`    context: ${hit.context}`);
    }
  }
}
console.log(`\nRESULT: total_matches=${hits.length} scanned=${scannedFiles}`);
