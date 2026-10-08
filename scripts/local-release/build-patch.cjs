const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Archive } = require('./asar.cjs');
const root = process.env.MASSCODE_PATCH_ROOT || __dirname;
const ts = require(path.join(root, 'runtime/node_modules/typescript'));
const source = path.join(root, 'source');
const plan = process.argv[2] ? JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) : null;
const destination = plan?.runtimePath || path.join(root, 'runtime-patched');
const manifestPath = plan?.manifestPath || path.join(root, 'patch-build-manifest.json');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const changed = execFileSync('git', ['diff', '--name-only'], { cwd: source, encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean);
const created = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: source, encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean);
const files = plan ? plan.files.map(item => item.file) : [...new Set([...changed, ...created])].filter(file => file.startsWith('src/') && file.endsWith('.ts') && !file.includes('/__tests__/'));
const retainedManifest = JSON.parse(fs.readFileSync(path.join(root, 'patch-build-manifest.json')));
const baselineCommit = retainedManifest.baseSourceCommit || retainedManifest.sourceCommit;
const selectedVersion = process.env.MASSCODE_PATCH_VERSION || retainedManifest.localVersion;
const retainedFiles = new Map(retainedManifest.files.map(file => [file.file, file.patchedSourceSha256]));
const differs = files.some(file => retainedFiles.get(file) !== hash(fs.readFileSync(path.join(source, file))));
if (differs && (!process.env.MASSCODE_PATCH_VERSION || selectedVersion === retainedManifest.localVersion)) throw new Error('Changed candidate sources require an explicit new MASSCODE_PATCH_VERSION; retained release outputs were not touched');
fs.mkdirSync(destination, { recursive: true });
if (!plan) {
  fs.cpSync(path.join(root, 'runtime/build'), path.join(destination, 'build'), { recursive: true });
  if (!fs.existsSync(path.join(destination, 'node_modules'))) fs.symlinkSync(path.join(root, 'runtime/node_modules'), path.join(destination, 'node_modules'), 'junction');
}
const configFile = ts.readConfigFile(path.join(source, 'tsconfig.main.json'), ts.sys.readFile);
const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, source);
const emitterOptions = { ...config.options, rootDir: undefined, outDir: undefined };
const archive = new Archive(path.join(root, 'official/resources/app.asar'));
const records = [];
try {
  for (const file of files) {
    const outputFile = file.replace(/^src\//, 'build/').replace(/\.ts$/, '.js');
    let originalSource, originalJs, sourceMatchesArtifact = null;
    if (archive.entry(outputFile)) {
      originalSource = execFileSync('git', ['show', `${baselineCommit}:${file}`], { cwd: source });
      originalJs = archive.read(outputFile);
      if (archive.entry(`${outputFile}.map`)) {
        const map = JSON.parse(archive.read(`${outputFile}.map`));
        sourceMatchesArtifact = map.sourcesContent?.[0]?.replaceAll('\r\n', '\n') === originalSource.toString('utf8').replaceAll('\r\n', '\n');
      } else {
        const compiled = ts.transpileModule(originalSource.toString('utf8'), { compilerOptions: emitterOptions, fileName: path.basename(file) }).outputText;
        sourceMatchesArtifact = compiled.replaceAll('\r\n', '\n') === originalJs.toString('utf8').replaceAll('\r\n', '\n');
      }
      if (!sourceMatchesArtifact) throw new Error(`Source differs from installed ASAR source map: ${file}`);
    }
    const text = fs.readFileSync(path.join(source, file), 'utf8');
    const expected = plan?.files.find(item => item.file === file);
    if (expected && hash(text) !== expected.sourceSha256) throw new Error(`Verified source changed: ${file}`);
    if (plan && execFileSync('git', ['show', `HEAD:${file}`], { cwd: source, encoding: 'utf8' }).replaceAll('\r\n', '\n') !== text.replaceAll('\r\n', '\n')) throw new Error(`Release source is not committed: ${file}`);
    const emitted = ts.transpileModule(text, { compilerOptions: emitterOptions, fileName: path.basename(file), reportDiagnostics: true });
    const errors = emitted.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error) || [];
    if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, { getCanonicalFileName: x => x, getCurrentDirectory: () => source, getNewLine: () => '\n' }));
    if (expected && hash(emitted.outputText) !== expected.compiledSha256) throw new Error(`Verified compiled module changed: ${file}`);
    const output = path.join(destination, outputFile);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, emitted.outputText);
    // Keep maps tied to the actual original source path, rather than a temporary emitter path.
    const map = JSON.parse(emitted.sourceMapText);
    map.sources = [path.relative(path.dirname(path.join(source, outputFile)), path.join(source, file)).replaceAll('\\', '/')];
    fs.writeFileSync(`${output}.map`, JSON.stringify(map));
    records.push({ file, outputFile, sourceMatchesArtifact, originalSourceSha256: originalSource && hash(originalSource), originalJsSha256: originalJs && hash(originalJs), patchedSourceSha256: hash(text), patchedJsSha256: hash(emitted.outputText) });
  }
} finally { archive.close(); }
const manifest = { upstreamVersion: '6.0.0', localVersion: selectedVersion, baseSourceCommit: baselineCommit, sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(), compiler: ts.version, files: records, generatedAt: new Date().toISOString() };
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ sourceCommit: manifest.sourceCommit, compiler: ts.version, files: records.length, boundExistingFiles: records.filter(record => record.sourceMatchesArtifact).length }));
