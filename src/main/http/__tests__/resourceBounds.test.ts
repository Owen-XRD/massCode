import { Buffer } from 'node:buffer'
import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import JSZip from 'jszip'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readImportResponse, validateImportInput, validateSnippetImport } from '../../import/common/limits'
import { readMarkdownFolder } from '../../import/notes/readFolder'
import { buildSearchIndex, querySearchIndex } from '../../storage/providers/markdown/runtime/shared/searchEngine'
import { HttpConsoleJournal } from '../devtools/console'
import { expandZipFiles } from '../import/zip'
import { buildBody } from '../runtime/execute'

vi.mock('../cookies/store', () => ({ getHttpCookieJar: () => ({}) }))
vi.mock('../secrets', () => ({ getEnvironmentSecrets: () => ({}) }))
vi.mock('../../storage/providers/markdown/runtime/paths', () => ({ getVaultPath: () => '/resource-test' }))
vi.mock('../../storage', () => ({ useHttpStorage: () => ({}) }))

const directories: string[] = []
function directory() {
  const result = mkdtempSync(join(tmpdir(), 'masscode-resource-'))
  directories.push(result)
  return result
}
function sparseFile(size: number) {
  const file = join(directory(), 'owned.bin')
  const descriptor = openSync(file, 'wx')
  try {
    ftruncateSync(descriptor, size)
  }
  finally {
    closeSync(descriptor)
  }
  return file
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true })
})

describe('resource boundaries and recovery', () => {
  it('bounds successful and unsuccessful query caches without changing results', () => {
    const text = Array.from({ length: 80 }, (_, i) => `variant${i}`).join(' ')
    const items = Array.from({ length: 2000 }, (_, id) => ({ id, text }))
    const getText = (item: typeof items[number]) => item.text
    const index = buildSearchIndex(items, getText)
    for (let i = 0; i < 80; i++)
      expect(querySearchIndex(items, `variant${i}`, index, getText).size).toBe(2000)
    expect([...index.queryCache.values()].reduce((total, ids) => total + ids.length, 0)).toBeLessThanOrEqual(16_384)
    for (let i = 0; i < 1000; i++)
      expect(querySearchIndex(items, `absent${i}`, index, getText).size).toBe(0)
    expect(index.queryCache.size).toBeLessThanOrEqual(64)
    expect(querySearchIndex(items, 'variant1', index, getText)).toEqual(querySearchIndex(items, 'variant1', null, getText))
  })

  it('keeps recently used results and searches oversized queries without retaining them', () => {
    const long = 'x'.repeat(1025)
    const items = [{ id: 1, text: `short ${long}` }]
    const getText = (item: typeof items[number]) => item.text
    const index = buildSearchIndex(items, getText)
    querySearchIndex(items, 'short', index, getText)
    for (let i = 0; i < 63; i++)
      querySearchIndex(items, `missing${i}`, index, getText)
    querySearchIndex(items, 'short', index, getText)
    querySearchIndex(items, 'new', index, getText)
    expect(index.queryCache.has('short')).toBe(true)
    expect(index.queryCache.has('missing0')).toBe(false)
    expect(querySearchIndex(items, long, index, getText)).toEqual(new Set([1]))
    expect(index.queryCache.has(long)).toBe(false)
  })

  it('caps AI copies and counts them against the same console capacity', () => {
    const journal = new HttpConsoleJournal()
    const content = { message: 'safe', details: { body: 'x'.repeat(300_000) } }
    for (let i = 0; i < 160; i++) {
      const id = journal.append({ kind: 'network', level: 'log', executionId: 'owned', message: 'small' })
      journal.publishAiContent(id, { executionId: 'owned', vaultPath: '/owned' }, content)
    }
    const visible = journal.read()
    const safe = journal.readForAi('/owned')
    expect(safe.entries.length).toBeLessThan(160)
    expect(safe.entries.every(entry => entry.truncated)).toBe(true)
    expect((JSON.stringify(visible).length + JSON.stringify(safe).length) * 2).toBeLessThan(32 * 1024 * 1024)
    content.details.body = 'changed'
    expect(JSON.stringify(journal.readForAi('/owned'))).not.toContain('changed')
    journal.clear()
    expect(journal.readForAi('/owned').entries).toEqual([])
    const clipped = journal.append({ kind: 'network', level: 'log', executionId: 'owned', message: 'x'.repeat(300_000) })
    journal.publishAiContent(clipped, { executionId: 'owned', vaultPath: '/owned' }, { message: 'safe' })
    expect(journal.readForAi('/owned').entries[0].truncated).toBe(true)
  })

  it('bounds numeric trees and oversized keys as well as strings', () => {
    const journal = new HttpConsoleJournal()
    journal.append({ kind: 'script', level: 'log', executionId: 'owned', message: 'ok', details: { tree: Array.from({ length: 1000 }, () => Array.from({ length: 1000 }, (_, i) => i)), ['k'.repeat(200_000)]: 1 } })
    const saved = journal.read().entries[0]
    expect(saved.truncated).toBe(true)
    expect(JSON.stringify(saved).length).toBeLessThan(132_000)
  })

  it('reads Markdown serially and rejects a large folder before returning partial data', async () => {
    const root = directory()
    writeFileSync(join(root, 'small.md'), '# 你好')
    expect((await readMarkdownFolder(root)).files[0].content).toBe('# 你好')
    writeFileSync(join(root, 'large.md'), 'x'.repeat(2 * 1024 * 1024 + 1))
    await expect(readMarkdownFolder(root)).rejects.toThrow('IMPORT_INPUT_LIMIT')
    rmSync(join(root, 'large.md'))
    expect((await readMarkdownFolder(root)).files).toHaveLength(1)
  })

  it('checks file count, UTF-8 size and aggregate import bytes before parsing', () => {
    expect(() => validateImportInput(Array.from({ length: 1001 }, () => ({ name: 'owned.md', content: '' })))).toThrow('IMPORT_INPUT_LIMIT')
    expect(() => validateImportInput([{ name: 'owned.md', content: '界'.repeat(700_000) }])).toThrow('IMPORT_INPUT_LIMIT')
    expect(() => validateImportInput(Array.from({ length: 9 }, () => ({ name: 'owned.md', content: 'x'.repeat(2 * 1024 * 1024) })))).toThrow('IMPORT_INPUT_LIMIT')
    expect(() => validateImportInput([{ name: 'owned.md', content: '# small' }])).not.toThrow()
    expect(() => validateSnippetImport({ snippets: [{ name: 'owned', contents: Array.from({ length: 1001 }, () => ({ label: 'owned', language: 'text', value: '' })) }], warnings: [] })).toThrow('IMPORT_INPUT_LIMIT')
  })

  it('cancels an oversized streamed Gist body despite a false Content-Length', async () => {
    let cancelled = false
    let chunks = 0
    const response = new Response(new ReadableStream({
      pull(controller) {
        if (++chunks <= 17)
          controller.enqueue(new Uint8Array(1024 * 1024))
        else controller.close()
      },
      cancel() { cancelled = true },
    }), { headers: { 'content-length': '1' } })
    await expect(readImportResponse(response)).rejects.toThrow('IMPORT_INPUT_LIMIT')
    expect(cancelled).toBe(true)
    expect(await readImportResponse(new Response('# next'))).toBe('# next')
  })

  it('destroys an overflowing ZIP entry instead of leaving a paused worker', async () => {
    const stream = Readable.from([Buffer.alloc(2 * 1024 * 1024), Buffer.alloc(1)])
    const zip = new JSZip().file('owned.json', '')
    zip.files['owned.json'].nodeStream = () => stream
    vi.spyOn(JSZip, 'loadAsync').mockResolvedValue(zip)
    await expect(expandZipFiles([{ name: 'owned.zip', content: '', encoding: 'base64' }])).rejects.toThrow('invalidArchive')
    expect(stream.destroyed).toBe(true)
  })

  it('includes ordinary files in the expansion budget of a mixed ZIP import', async () => {
    const zip = new JSZip().file('first.json', '').file('second.json', '')
    const streams = Object.values(zip.files).map((entry) => {
      const stream = Readable.from([Buffer.alloc(2 * 1024 * 1024)])
      entry.nodeStream = () => stream
      return stream
    })
    vi.spyOn(JSZip, 'loadAsync').mockResolvedValue(zip)
    const plain = Array.from({ length: 7 }, (_, i) => ({ name: `owned${i}.json`, content: ' '.repeat(2 * 1024 * 1024) }))
    await expect(expandZipFiles([...plain, { name: 'owned.zip', content: '', encoding: 'base64' }])).rejects.toThrow('invalidArchive')
    expect(streams.every(stream => stream.destroyed)).toBe(true)
  })

  it('rejects oversized or aggregate uploads and still reads the next small file', () => {
    const oversized = sparseFile(16 * 1024 * 1024 + 1)
    expect(() => buildBody('binary', oversized, [])).toThrow('HTTP_BODY_FILE_UNAVAILABLE')
    const shared = sparseFile(8 * 1024 * 1024 + 1)
    expect(() => buildBody('multipart', null, [{ key: 'one', value: shared, type: 'file' }, { key: 'two', value: shared, type: 'file' }])).toThrow('HTTP_BODY_FILE_UNAVAILABLE')
    const small = join(directory(), 'small.bin')
    writeFileSync(small, 'owned bytes')
    expect(buildBody('binary', small, []).body).toEqual(Buffer.from('owned bytes'))
  })
})
