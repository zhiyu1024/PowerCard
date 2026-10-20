/**
 * Independent QA helper: scan classes.dex of the release APK for required
 * class descriptors / bridge strings / risky tokens.
 * Usage: node qa/apk-verify/dex-check.js
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DEX = path.join(
  ROOT,
  'qa',
  'apk-verify',
  'apk-extract',
  'unzipped',
  'classes.dex',
);

const buf = readFileSync(DEX);

// Extract printable ASCII runs (length >= 4). DEX MUTF-8 keeps ASCII
// identifiers verbatim; this is enough for class descriptors / bridge names.
const runs = [];
let current = [];
for (let i = 0; i < buf.length; i++) {
  const byte = buf[i];
  if (byte >= 0x20 && byte <= 0x7e) {
    current.push(byte);
  } else {
    if (current.length >= 4) runs.push(Buffer.from(current).toString('latin1'));
    current = [];
  }
}
if (current.length >= 4) runs.push(Buffer.from(current).toString('latin1'));
const haystack = runs.join('\n');

const requiredClasses = [
  'Lcom/powercard/remote/MainActivity;',
  'Lcom/powercard/remote/NativeBridge;',
  'Lcom/powercard/remote/NativeHttpClient;',
  'Lcom/powercard/remote/SecureConfigStore;',
  'Lcom/powercard/remote/RootAssetsPathHandler;',
];
const requiredStrings = [
  'PowerCardNative',
  'getConfigJson',
  'saveConfigJson',
  'httpGet',
  'window.__powercardHttpResult',
  'AES/GCM/NoPadding',
  'copyText',
  'getAppVersion',
];
const riskyStrings = [
  'OnBackInvoked',
  'OnBackInvokedDispatcher',
  'OnBackInvokedCallback',
];

const results = { dex: path.relative(ROOT, DEX), size: buf.length, required: {}, risky: {} };
let failed = 0;

console.log(`DEX: ${path.relative(ROOT, DEX)} (${buf.length} bytes, ${runs.length} ascii runs)`);
console.log('\n[required class descriptors]');
for (const item of requiredClasses) {
  const found = haystack.includes(item);
  results.required[item] = found;
  if (!found) failed++;
  console.log(`${found ? 'FOUND  ' : 'MISSING'} ${item}`);
}
console.log('\n[required bridge strings]');
for (const item of requiredStrings) {
  const found = haystack.includes(item);
  results.required[item] = found;
  if (!found) failed++;
  console.log(`${found ? 'FOUND  ' : 'MISSING'} ${item}`);
}
console.log('\n[risky API-33 strings]');
for (const item of riskyStrings) {
  const found = haystack.includes(item);
  results.risky[item] = found;
  console.log(`${found ? 'PRESENT' : 'ABSENT '} ${item}`);
}

// Extra context: these strings are expected and explain implementation choices.
console.log('\n[context strings]');
for (const item of [
  'setWebContentsDebuggingEnabled',
  'addJavascriptInterface',
  'setAllowFileAccess',
  'shouldOverrideUrlLoading',
  'HttpURLConnection',
  'setRequestMethod',
  'Keystore',
  'AndroidKeyStore',
  'onBackPressed',
]) {
  console.log(`${haystack.includes(item) ? 'PRESENT' : 'ABSENT '} ${item}`);
}

console.log(`\nRESULT: required_failed=${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
