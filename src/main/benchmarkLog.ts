import fs from 'node:fs'

export const BENCHMARK_LOG_BYTES = 1024 * 1024
export const BENCHMARK_RECORD_BYTES = 64 * 1024
const GENERATIONS = 2

function size(file: string): number {
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid benchmark log file')
    return stat.size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
}

// Bound legacy diagnostic files too, reading only a complete-line tail.
function cap(file: string): void {
  const length = size(file)
  if (length <= BENCHMARK_LOG_BYTES) return
  const descriptor = fs.openSync(file, 'r+')
  try {
    const tail = Buffer.alloc(BENCHMARK_LOG_BYTES)
    const read = fs.readSync(descriptor, tail, 0, tail.length, length - tail.length)
    const first = tail.indexOf(10)
    const complete = first < 0 ? Buffer.alloc(0) : tail.subarray(first + 1, read)
    fs.ftruncateSync(descriptor, 0)
    fs.writeFileSync(descriptor, complete)
  } finally {
    fs.closeSync(descriptor)
  }
}

// Called by the actual producer on every append, never by a parent drain.
export function appendBenchmarkLines(file: string, lines: string[]): void {
  for (let generation = 0; generation <= GENERATIONS; generation++)
    cap(generation ? `${file}.${generation}` : file)
  for (const line of lines) {
    const bytes = Buffer.byteLength(line, 'utf8')
    const record =
      bytes > BENCHMARK_RECORD_BYTES
        ? JSON.stringify({ diagnostic: 'oversized-record-omitted', bytes })
        : line
    const data = `${record}\n`
    if (size(file) + Buffer.byteLength(data, 'utf8') > BENCHMARK_LOG_BYTES) {
      fs.rmSync(`${file}.${GENERATIONS}`, { force: true })
      for (let generation = GENERATIONS - 1; generation >= 0; generation--) {
        const from = generation ? `${file}.${generation}` : file
        if (size(from)) fs.renameSync(from, `${file}.${generation + 1}`)
      }
    }
    fs.appendFileSync(file, data, 'utf8')
  }
}
