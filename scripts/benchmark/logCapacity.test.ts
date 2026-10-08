import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { appendBenchmarkLines, BENCHMARK_LOG_BYTES } from '../../src/main/benchmarkLog'

const { readReportWindow } = require('./reportWindow.cjs')
let root = ''
afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true })
})

it('bounds both continuously written streams across rotation and restart', () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-capacity-'))
  for (const name of ['events.jsonl', 'memory.jsonl']) {
    const file = path.join(root, name)
    for (let i = 0; i < 160; i++) {
      appendBenchmarkLines(file, [
        JSON.stringify({
          name: 'test',
          durationMs: 1,
          status: 'ok',
          i,
          padding: 'x'.repeat(24000),
        }),
      ])
      const members = fs
        .readdirSync(root)
        .filter((member) => member === name || member.startsWith(`${name}.`))
      expect(members.length).toBeLessThanOrEqual(3)
      expect(
        members.every((member) => fs.statSync(path.join(root, member)).size <= BENCHMARK_LOG_BYTES),
      ).toBe(true)
    }
    appendBenchmarkLines(file, [JSON.stringify({ name: 'restart', durationMs: 2, status: 'ok' })])
  }
  expect(
    fs.readdirSync(root).reduce((sum, name) => sum + fs.statSync(path.join(root, name)).size, 0),
  ).toBeLessThanOrEqual(6 * BENCHMARK_LOG_BYTES)
  expect(readReportWindow(root).rows.at(-1).name).toBe('restart')
})

it('caps oversized legacy generations and omits oversized individual records explicitly', () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-legacy-'))
  const file = path.join(root, 'events.jsonl')
  const row = `${JSON.stringify({ name: 'legacy', durationMs: 1, status: 'ok', padding: 'x'.repeat(4000) })}\n`
  for (const member of [file, `${file}.1`, `${file}.2`]) fs.writeFileSync(member, row.repeat(270))
  appendBenchmarkLines(file, ['x'.repeat(100000)])
  expect(
    fs
      .readdirSync(root)
      .every((name) => fs.statSync(path.join(root, name)).size <= BENCHMARK_LOG_BYTES),
  ).toBe(true)
  const { window } = readReportWindow(root)
  expect(window.diagnosticRows).toBe(1)
  expect(window.readBytes).toBeLessThanOrEqual(3 * BENCHMARK_LOG_BYTES)
})

it('reads bounded complete-line tails from preexisting unbounded reports', () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-report-window-'))
  const row = `${JSON.stringify({ name: 'old', durationMs: 1, status: 'ok', padding: 'x'.repeat(4000) })}\n`
  fs.writeFileSync(path.join(root, 'events.jsonl'), `${row.repeat(270)}{"partial"`)
  const { rows, window } = readReportWindow(root)
  expect(rows.length).toBeGreaterThan(0)
  expect(window.omittedBytes).toBeGreaterThan(0)
  expect(window.incompleteLines).toBe(2)
  expect(window.readBytes).toBeLessThanOrEqual(BENCHMARK_LOG_BYTES)
})
