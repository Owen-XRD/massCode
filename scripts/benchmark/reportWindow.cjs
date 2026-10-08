const fs = require('node:fs')
const path = require('node:path')
const FILE_BYTES = 1024 * 1024

function readReportWindow(root) {
  const rows = []
  const window = { perFileBytes: FILE_BYTES, maximumBytes: 3 * FILE_BYTES, readBytes: 0, omittedBytes: 0, diagnosticRows: 0, incompleteLines: 0, files: [] }
  for (const name of ['events.jsonl.2', 'events.jsonl.1', 'events.jsonl']) {
    const file = path.join(root, name)
    if (!fs.existsSync(file)) continue
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid benchmark log file')
    const descriptor = fs.openSync(file, 'r')
    let text
    try {
      const length = fs.fstatSync(descriptor).size
      const start = Math.max(0, length - FILE_BYTES)
      const bytes = Buffer.alloc(Math.min(length, FILE_BYTES))
      let read = 0
      while (read < bytes.length) {
        const count = fs.readSync(descriptor, bytes, read, bytes.length - read, start + read)
        if (!count) break
        read += count
      }
      window.readBytes += read
      window.omittedBytes += start
      let tail = bytes.subarray(0, read)
      if (start) {
        const first = tail.indexOf(10)
        tail = first < 0 ? Buffer.alloc(0) : tail.subarray(first + 1)
        window.incompleteLines++
      }
      if (tail.length && tail.at(-1) !== 10) {
        tail = tail.subarray(0, tail.lastIndexOf(10) + 1)
        window.incompleteLines++
      }
      text = tail.toString('utf8')
    }
    finally { fs.closeSync(descriptor) }
    window.files.push(name)
    for (const line of text.split('\n').filter(Boolean)) {
      const row = JSON.parse(line)
      if (row.diagnostic) { window.diagnosticRows++; continue }
      rows.push(row)
    }
  }
  return { rows, window }
}
module.exports = { readReportWindow }
