const fs = require('node:fs');
const crypto = require('node:crypto');

function writeAll(descriptor, bytes, length = bytes.length) {
  let written = 0;
  while (written < length) {
    const count = fs.writeSync(descriptor, bytes, written, length - written);
    if (count <= 0) throw new Error('Archive write made no progress');
    written += count;
  }
}

// The last committed archive remains untouched until the complete candidate
// has been flushed and read back. Every owned intermediate is removed on error.
function publishArchive({ destination, prefix, header, entries, overlays, original, verify }) {
  const temporary = `${destination}.${crypto.randomUUID()}.building`;
  let descriptor;
  let owned = false;
  try {
    descriptor = fs.openSync(temporary, 'wx');
    owned = true;
    writeAll(descriptor, prefix);
    writeAll(descriptor, header);
    const buffer = Buffer.alloc(1024 * 1024);
    for (const [name, entry] of entries) {
      if (entry.unpacked || entry.link) continue;
      const overlay = overlays.get(name);
      if (overlay) { writeAll(descriptor, overlay); continue; }
      const source = original.entry(name);
      let copied = 0;
      while (copied < source.size) {
        const length = Math.min(buffer.length, source.size - copied);
        const read = fs.readSync(original.fd, buffer, 0, length, original.dataOffset + Number(source.offset) + copied);
        if (!read) throw new Error(`Unexpected archive EOF: ${name}`);
        writeAll(descriptor, buffer, read);
        copied += read;
      }
    }
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    verify(temporary);
    fs.renameSync(temporary, destination);
  }
  finally {
    try { if (descriptor !== undefined) fs.closeSync(descriptor); }
    finally { if (owned && fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
}
module.exports = { publishArchive };
