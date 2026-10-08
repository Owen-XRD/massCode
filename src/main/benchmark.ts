import type { WebContents } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { app } from 'electron'
import { isTrustedApiRequest } from './api/requestIpc'
import { appendBenchmarkLines, BENCHMARK_RECORD_BYTES } from './benchmarkLog'

function resolveRoot(): string | undefined {
  const root = process.env.MASSCODE_BENCHMARK_ROOT
  if (!root)
    return
  const actual = fs.realpathSync(root)
  const marker = JSON.parse(
    fs.readFileSync(path.join(actual, '.masscode-benchmark.json'), 'utf8'),
  )
  if (
    marker.version !== 1
    || marker.root !== actual
    || app.getPath('userData') !== path.join(actual, 'profile')
  ) {
    throw new Error('Invalid benchmark profile')
  }
  for (const name of ['profile', 'vault']) {
    if (fs.realpathSync(path.join(actual, name)) !== path.join(actual, name))
      throw new Error('Invalid benchmark path')
  }
  return actual
}

const root = resolveRoot()
export const benchmarkEnabled = Boolean(root)
const session = `${Date.now()}-${process.pid}`
const startedAt = Number(process.env.MASSCODE_BENCHMARK_STARTED || 0)
let buffer: string[] = []
let bufferedBytes = 0
const memoryMilestones = new Set<string>()
let memoryBuffer: string[] = []
let memoryBufferedBytes = 0
let timer: ReturnType<typeof setTimeout> | undefined
function flush() {
  if (timer) clearTimeout(timer)
  if (root && buffer.length) {
    appendBenchmarkLines(path.join(root, 'events.jsonl'), buffer)
    buffer = []
    bufferedBytes = 0
  }
  if (root && memoryBuffer.length) {
    appendBenchmarkLines(path.join(root, 'memory.jsonl'), memoryBuffer)
    memoryBuffer = []
    memoryBufferedBytes = 0
  }
  timer = undefined
}

function recordMemory(milestone: string) {
  if (memoryMilestones.has(milestone)) return
  memoryMilestones.add(milestone)
  const record = JSON.stringify({
    session,
    milestone,
    elapsedMs: performance.now() - startedAt,
    processes: app.getAppMetrics().map(({ pid, type, memory }) => ({ pid, type, memory })),
  })
  const bytes = Buffer.byteLength(record, 'utf8')
  if (memoryBufferedBytes + bytes > BENCHMARK_RECORD_BYTES || memoryBuffer.length >= 64) flush()
  if (bytes > BENCHMARK_RECORD_BYTES) {
    if (root) appendBenchmarkLines(path.join(root, 'memory.jsonl'), [record])
    return
  }
  memoryBuffer.push(record)
  memoryBufferedBytes += bytes
}

export function recordBenchmark(name: string, durationMs: number, status = 'ok') {
  if (!root || !Number.isFinite(durationMs) || durationMs < 0 || durationMs > 3600000) {
    return
  }
  const record = JSON.stringify({
    session,
    name,
    durationMs,
    status,
    timestamp: Date.now(),
    elapsedMs: performance.now() - startedAt,
  })
  const bytes = Buffer.byteLength(record, 'utf8')
  if (bufferedBytes + bytes > BENCHMARK_RECORD_BYTES || buffer.length >= 128) flush()
  // An oversized record is handled immediately by the writer; never queue it.
  if (bytes > BENCHMARK_RECORD_BYTES) {
    appendBenchmarkLines(path.join(root, 'events.jsonl'), [record])
    return
  }
  buffer.push(record)
  bufferedBytes += bytes
  if (!timer) {
    timer = setTimeout(flush, 1000)
    timer.unref()
  }
}

export function registerBenchmark(
  webContents: WebContents,
  rendererUrl: string,
) {
  if (!root)
    return
  webContents.ipc.handle(
    'system:benchmark-event',
    async (event, payload: unknown) => {
      if (!isTrustedApiRequest(event, webContents, rendererUrl))
        throw new Error('Unauthorized IPC sender')
      if (!payload || typeof payload !== 'object')
        return
      const { name, durationMs, status } = payload as Record<string, unknown>
      if (
        typeof name !== 'string'
        || !/^(?:code|notes|http)\.(?:list|open|search-first|search-new|search-repeat|sidebar-filter)\.state-presented$/.test(
          name,
        )
        || typeof durationMs !== 'number'
        || !Number.isFinite(durationMs)
        || durationMs < 0
        || durationMs > 3600000
        || !['ok', 'error', 'superseded'].includes(String(status))
      ) {
        return
      }
      recordBenchmark(name, durationMs, String(status))
      if (status === 'ok' && /\.(?:list|open|search-first)\./.test(name))
        recordMemory(name)
    },
  )
  webContents.on('did-finish-load', () => {
    recordBenchmark(
      'startup.renderer-document-loaded',
      performance.now() - Number(process.env.MASSCODE_BENCHMARK_STARTED || 0),
    )
    recordMemory('renderer-document-loaded')
  })
}

if (root) {
  recordBenchmark(
    'startup.main-imported',
    performance.now() - Number(process.env.MASSCODE_BENCHMARK_STARTED || 0),
  )
  app.on('will-quit', flush)
}
