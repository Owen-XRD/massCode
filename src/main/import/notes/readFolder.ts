import type { ImportMarkdownFolderResponse } from '../../types/ipc'
import { Buffer } from 'node:buffer'
import { createReadStream } from 'node:fs'
import { lstat, opendir, realpath } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import slash from 'slash'
import { IMPORT_FILE_BYTES, IMPORT_FILE_COUNT, IMPORT_TOTAL_BYTES } from '../common/limits'

export async function readMarkdownFolder(rootPath: string): Promise<ImportMarkdownFolderResponse> {
  const files: ImportMarkdownFolderResponse['files'] = []
  const warnings: ImportMarkdownFolderResponse['warnings'] = []
  const visited = new Set<string>()
  const pending = [rootPath]
  let bytes = 0
  let entries = 0
  while (pending.length) {
    const dirPath = pending.pop()!
    let directory: Awaited<ReturnType<typeof opendir>>
    try {
      const resolved = await realpath(dirPath)
      if (visited.has(resolved))
        continue
      visited.add(resolved)
      directory = await opendir(dirPath)
    }
    catch {
      warnings.push({ code: 'fs.folderReadFailed', source: slash(relative(rootPath, dirPath)) || '.' })
      continue
    }
    // The iterator closes its directory handle on exhaustion or an exception.
    for await (const entry of directory) {
      if (++entries > 10_000)
        throw new Error('IMPORT_INPUT_LIMIT')
      const absolute = join(dirPath, entry.name)
      const relativePath = slash(relative(rootPath, absolute))
      try {
        const stat = await lstat(absolute)
        if (stat.isSymbolicLink())
          continue
        if (stat.isDirectory()) {
          pending.push(absolute)
          continue
        }
        if (!stat.isFile() || extname(entry.name).toLowerCase() !== '.md')
          continue
        if (stat.size > IMPORT_FILE_BYTES || files.length >= IMPORT_FILE_COUNT || bytes + stat.size > IMPORT_TOTAL_BYTES)
          throw new Error('IMPORT_INPUT_LIMIT')
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of createReadStream(absolute)) {
          size += chunk.length
          if (size > IMPORT_FILE_BYTES || bytes + size > IMPORT_TOTAL_BYTES)
            throw new Error('IMPORT_INPUT_LIMIT')
          chunks.push(chunk as Buffer)
        }
        bytes += size
        files.push({ content: Buffer.concat(chunks).toString('utf8'), name: entry.name, relativePath })
      }
      catch (error) {
        if (error instanceof Error && error.message === 'IMPORT_INPUT_LIMIT')
          throw error
        warnings.push({ code: 'fs.fileReadFailed', source: relativePath })
      }
    }
  }
  return { canceled: false, files, warnings }
}
