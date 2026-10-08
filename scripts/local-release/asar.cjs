const fs = require('node:fs');
const path = require('node:path');

class Archive {
  constructor(file) {
    this.file = file;
    this.fd = fs.openSync(file, 'r');
    const prefix = Buffer.alloc(16);
    fs.readSync(this.fd, prefix, 0, 16, 0);
    const headerSize = prefix.readUInt32LE(4);
    const jsonSize = prefix.readUInt32LE(12);
    const json = Buffer.alloc(jsonSize);
    fs.readSync(this.fd, json, 0, jsonSize, 16);
    this.header = JSON.parse(json.toString('utf8'));
    this.dataOffset = 8 + headerSize;
  }
  entry(name) {
    let entry = this.header;
    for (const segment of name.split('/')) entry = entry.files?.[segment];
    return entry;
  }
  read(name) {
    const entry = this.entry(name);
    if (!entry || entry.files) throw new Error(`Missing ASAR file: ${name}`);
    if (entry.unpacked) return fs.readFileSync(path.join(`${this.file}.unpacked`, name));
    const result = Buffer.alloc(entry.size);
    fs.readSync(this.fd, result, 0, entry.size, this.dataOffset + Number(entry.offset));
    return result;
  }
  *files(entry = this.header, prefix = '') {
    for (const [name, child] of Object.entries(entry.files || {})) {
      const relative = prefix ? `${prefix}/${name}` : name;
      if (child.files) yield* this.files(child, relative);
      else yield [relative, child];
    }
  }
  extract(root, prefixes) {
    let count = 0, bytes = 0;
    for (const [name, entry] of this.files()) {
      if (!prefixes.some(prefix => name === prefix || name.startsWith(`${prefix}/`))) continue;
      if (entry.unpacked) continue;
      const target = path.resolve(root, name);
      if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('Outside extraction root');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, this.read(name));
      count++; bytes += entry.size;
    }
    return { count, bytes };
  }
  close() { fs.closeSync(this.fd); }
}
module.exports = { Archive };

if (require.main === module) {
  const [, , file, command, ...args] = process.argv;
  const archive = new Archive(file);
  try {
    if (command === 'read') process.stdout.write(archive.read(args[0]));
    else if (command === 'extract') console.log(JSON.stringify(archive.extract(args[0], args.slice(1))));
    else if (command === 'list') {
      for (const [name, entry] of archive.files()) if (!args[0] || name.startsWith(args[0])) console.log(`${entry.size}\t${name}`);
    }
  } finally { archive.close(); }
}
