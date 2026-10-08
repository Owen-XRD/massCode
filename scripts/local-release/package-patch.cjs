const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = process.env.MASSCODE_PATCH_ROOT || __dirname;
const { Pickle } = require(path.join(root, 'runtime/node_modules/@electron/asar/lib/pickle'));
const asar = require(path.join(root, 'runtime/node_modules/@electron/asar'));
const { Archive } = require('./asar.cjs');
const { publishArchive } = require('./publish-asar.cjs');
const manifest = JSON.parse(fs.readFileSync(process.env.MASSCODE_PATCH_MANIFEST || path.join(root, 'patch-build-manifest.json')));
const compiledRoot = process.env.MASSCODE_PATCH_COMPILED || path.join(root, 'runtime-patched');
const official = process.env.MASSCODE_PATCH_OFFICIAL || path.join(root, 'official');
const verifyOnly = process.argv.includes('--verify-only');
const auditMode = process.argv.includes('--audit');
const releaseArgument = process.argv.slice(2).find(argument => !argument.startsWith('--'));
const release = auditMode ? path.join(root, 'isolated-runtime') : (releaseArgument || path.resolve(root, '../../releases', manifest.localVersion));
if (path.resolve(release) === path.resolve(official)) throw new Error('Cannot overwrite the official recovery anchor');
fs.mkdirSync(release, { recursive: true });
function sameBytes(first, second) {
  const handles = [fs.openSync(first, 'r'), fs.openSync(second, 'r')];
  try {
    if (fs.fstatSync(handles[0]).size !== fs.fstatSync(handles[1]).size) return false;
    const buffers = [Buffer.alloc(1024 * 1024), Buffer.alloc(1024 * 1024)];
    let count;
    while ((count = fs.readSync(handles[0], buffers[0], 0, buffers[0].length, null))) {
      const actual = fs.readSync(handles[1], buffers[1], 0, count, null);
      if (actual !== count || !buffers[0].subarray(0, count).equals(buffers[1].subarray(0, actual))) return false;
    }
    return true;
  }
  finally { handles.forEach(handle => fs.closeSync(handle)); }
}
function copyRuntime(from, to) {
  for (const item of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, item.name);
    const destination = path.join(to, item.name);
    if (source === path.join(official, 'resources', 'app.asar')) continue;
    if (fs.lstatSync(source).isSymbolicLink()) throw new Error('Runtime source must not contain links');
    if (item.isDirectory()) { fs.mkdirSync(destination, { recursive: true }); copyRuntime(source, destination); }
    else if (!fs.existsSync(destination)) {
      // Disposable audit copies reuse immutable official files. Formal releases
      // retain independent runtime copies and an independent ASAR.
      if (auditMode) fs.linkSync(source, destination);
      else fs.copyFileSync(source, destination);
    }
    else if (fs.lstatSync(destination).isSymbolicLink() || !sameBytes(source, destination)) throw new Error(`Existing runtime differs: ${item.name}`);
  }
}
if (!verifyOnly) copyRuntime(official, release);
const input = new Archive(path.join(official, 'resources/app.asar'));
const overlays = new Map();
for (const file of manifest.files) {
  for (const suffix of ['', '.map']) overlays.set(`${file.outputFile}${suffix}`, fs.readFileSync(path.join(compiledRoot, `${file.outputFile}${suffix}`)));
  if (crypto.createHash('sha256').update(overlays.get(file.outputFile)).digest('hex') !== file.patchedJsSha256) throw new Error(`Compiled overlay differs from retained manifest: ${file.outputFile}`);
}
const packageJson = JSON.parse(input.read('package.json'));
packageJson.version = manifest.localVersion;
if (auditMode) {
  packageJson.name = 'masscode-review-local';
  packageJson.main = 'review/electron-smoke.cjs';
  overlays.set('review/electron-smoke.cjs', fs.readFileSync(path.join(root, 'electron-smoke.cjs')));
}
overlays.set('package.json', Buffer.from(JSON.stringify(packageJson, null, 2)));
const digest = content => crypto.createHash('sha256').update(content).digest('hex');
const integrity = content => {
  const blockSize = 4 * 1024 * 1024;
  const blocks = [];
  for (let start = 0; start < content.length; start += blockSize) blocks.push(digest(content.subarray(start, start + blockSize)));
  return { algorithm: 'SHA256', hash: digest(content), blockSize, blocks };
};
function entryFor(name) {
  let node = input.header;
  const parts = name.split('/');
  for (const directory of parts.slice(0, -1)) { node.files ||= {}; node.files[directory] ||= { files: {} }; node = node.files[directory]; }
  node.files ||= {};
  return node.files[parts.at(-1)] ||= {};
}
for (const [name, content] of overlays) Object.assign(entryFor(name), { size: content.length, integrity: integrity(content) });
const entries = [...input.files()];
let offset = 0;
for (const [name, entry] of entries) {
  if (entry.unpacked || entry.link) continue;
  entry.offset = String(offset);
  offset += entry.size;
}
const header = new Pickle();
header.writeString(JSON.stringify(input.header));
const headerBuffer = header.toBuffer();
const prefix = new Pickle();
prefix.writeUInt32(headerBuffer.length);
const destination = path.join(release, 'resources', 'app.asar');
const buffer = Buffer.alloc(1024 * 1024);
// Header entries were mutated in place; obtain original offsets from an independent header.
const original = new Archive(path.join(official, 'resources/app.asar'));
try {
  if (!verifyOnly) {
    publishArchive({ destination, prefix: prefix.toBuffer(), header: headerBuffer, entries, overlays, original, verify: candidate => {
      for (const [name, expected] of overlays) {
        if (!asar.extractFile(candidate, path.normalize(name)).equals(expected)) throw new Error(`Archive readback mismatch: ${name}`);
      }
    } });
  }
} finally { original.close(); input.close(); }
for (const [name, expected] of overlays) {
  if (!asar.extractFile(destination, path.normalize(name)).equals(expected)) throw new Error(`Archive readback mismatch: ${name}`);
}
const hashFile = file => {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try { let count; while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count)); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
};
const receipt = { version: manifest.localVersion, upstreamVersion: manifest.upstreamVersion, sourceCommit: manifest.sourceCommit, release, executableSha256: hashFile(path.join(release, 'massCode.exe')), asarSha256: hashFile(destination), overlayCount: overlays.size, generatedAt: new Date().toISOString(), compiler: manifest.compiler, method: 'Official Electron runtime with verified local TypeScript module overlay; no fuse or upstream release changes' };
fs.writeFileSync(process.env.MASSCODE_PATCH_RECEIPT || path.join(root, auditMode ? 'isolated-release.json' : 'local-release.json'), JSON.stringify(receipt, null, 2));
fs.writeFileSync(path.join(release, 'LOCAL_PATCH.json'), JSON.stringify({ ...receipt, files: manifest.files }, null, 2));
console.log(JSON.stringify(receipt));
