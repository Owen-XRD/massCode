import type { ImportFile, SnippetImportParseResult } from './types'
import { Buffer } from 'node:buffer'

export const IMPORT_FILE_BYTES = 2 * 1024 * 1024
export const IMPORT_TOTAL_BYTES = 16 * 1024 * 1024
export const IMPORT_FILE_COUNT = 1000

export function validateSnippetImport(result: SnippetImportParseResult): void {
  if (result.snippets.length > IMPORT_FILE_COUNT
    || result.snippets.reduce((count, snippet) => count + snippet.contents.length, 0) > IMPORT_FILE_COUNT) {
    throw new Error('IMPORT_INPUT_LIMIT')
  }
}

export function validateImportInput(files: ImportFile[]): void {
  let total = 0
  if (files.length > IMPORT_FILE_COUNT)
    throw new Error('IMPORT_INPUT_LIMIT')
  for (const file of files) {
    const size = Buffer.byteLength(file.content)
    total += size
    if (size > IMPORT_FILE_BYTES || total > IMPORT_TOTAL_BYTES)
      throw new Error('IMPORT_INPUT_LIMIT')
  }
}

export async function readImportResponse(response: Response): Promise<string> {
  if (!response.body)
    return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const parts: string[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done)
        break
      size += value.byteLength
      if (size > IMPORT_TOTAL_BYTES)
        throw new Error('IMPORT_INPUT_LIMIT')
      parts.push(decoder.decode(value, { stream: true }))
    }
    parts.push(decoder.decode())
    return parts.join('')
  }
  catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  }
  finally {
    reader.releaseLock()
  }
}
