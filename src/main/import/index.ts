import type {
  ImportApplySummary,
  ImportPayload,
  ImportPreview,
  ImportSource,
} from './common/types'
import { validateImportInput } from './common/limits'
import { detectImportSource } from './detect'
import { applyObsidianImport, previewObsidianImport } from './notes'
import { applySnippetImport, previewSnippetImport } from './snippets'

export async function previewImport(
  source: ImportSource | undefined,
  payload: ImportPayload = {},
): Promise<ImportPreview> {
  validateImportInput(payload.files ?? [])
  const resolvedSource = detectImportSource(source, payload)

  if (resolvedSource === 'obsidian') {
    return previewObsidianImport(payload)
  }

  return previewSnippetImport(resolvedSource, payload)
}

export async function applyImport(
  source: ImportSource | undefined,
  payload: ImportPayload = {},
): Promise<ImportApplySummary> {
  validateImportInput(payload.files ?? [])
  const resolvedSource = detectImportSource(source, payload)

  if (resolvedSource === 'obsidian') {
    return applyObsidianImport(payload)
  }

  return applySnippetImport(resolvedSource, payload)
}
