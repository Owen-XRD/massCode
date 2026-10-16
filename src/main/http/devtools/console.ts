import type {
  HttpConsoleEntry,
  HttpConsoleEvent,
} from '../../../shared/httpDevtools'
import { randomUUID } from 'node:crypto'
import {
  CONSOLE_MAX_AGE,
  CONSOLE_MAX_ENTRIES,
} from '../../../shared/httpDevtools'

const MAX_TEXT = 128 * 1024
const MAX_BYTES = 32 * 1024 * 1024

type ConsoleContent = Pick<HttpConsoleEntry, 'message' | 'details' | 'truncated'>

function boundContent(content: ConsoleContent): ConsoleContent {
  let remaining = MAX_TEXT
  let remainingKeys = 16 * 1024
  let nodes = 2048
  let truncated = content.truncated ?? false
  const cap = (value: unknown, depth = 0): unknown => {
    if (--nodes < 0 || remaining <= 0 || depth > 8) {
      truncated = true
      return '[…]'
    }
    if (typeof value === 'string') {
      const size = Math.min(value.length, remaining)
      remaining -= size
      if (size < value.length) {
        truncated = true
        return `${value.slice(0, size)}…`
      }
      return value
    }
    if (Array.isArray(value)) {
      const result: unknown[] = []
      for (const item of value) {
        if (result.length >= 1000 || nodes <= 0 || remaining <= 0) {
          truncated = true
          break
        }
        result.push(cap(item, depth + 1))
      }
      return result
    }
    if (value && typeof value === 'object') {
      const result: Record<string, unknown> = Object.create(null)
      let count = 0
      for (const key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key))
          continue
        if (++count > 1000 || nodes <= 0 || key.length >= remainingKeys) {
          truncated = true
          break
        }
        remainingKeys -= key.length
        result[key] = cap((value as Record<string, unknown>)[key], depth + 1)
      }
      return result
    }
    return value
  }
  const message = cap(content.message) as string
  const details = content.details
    ? cap(content.details) as Record<string, unknown>
    : undefined
  return { message, details, truncated }
}

export class HttpConsoleJournal {
  private aiContent = new Map<
    string,
    {
      content: ConsoleContent
      vaultPath?: string
    }
  >()

  private entries = new Map<string, HttpConsoleEntry>()
  private sizes = new Map<string, number>()
  private bytes = 0
  private revision = 0
  private listeners = new Set<(event: HttpConsoleEvent) => void>()
  subscribe(listener: (event: HttpConsoleEvent) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: HttpConsoleEvent) {
    this.listeners.forEach((listener) => {
      try {
        listener(event)
      }
      catch {
        /* Diagnostics must never interrupt a request. */
      }
    })
  }

  private prune(now = Date.now()) {
    for (const [id, entry] of this.entries) {
      if (
        entry.timestamp >= now - CONSOLE_MAX_AGE
        && this.entries.size <= CONSOLE_MAX_ENTRIES
        && this.bytes <= MAX_BYTES
      ) {
        break
      }
      this.bytes -= this.sizes.get(id) ?? 0
      this.sizes.delete(id)
      this.entries.delete(id)
      this.aiContent.delete(id)
    }
  }

  get(id: string) {
    return this.entries.get(id)
  }

  read() {
    this.prune()
    return { revision: this.revision, entries: [...this.entries.values()] }
  }

  readForAi(vaultPath?: string) {
    const snapshot = this.read()
    return {
      ...snapshot,
      entries: snapshot.entries
        .filter((entry) => {
          const safe = this.aiContent.get(entry.id)
          return !safe?.vaultPath || safe.vaultPath === vaultPath
        })
        .map(({ message: _message, details: _details, ...entry }) => {
          const safe = this.aiContent.get(entry.id)?.content
          return {
            ...entry,
            ...(safe ?? { message: '[CONTENT_UNAVAILABLE_FOR_AI]' }),
            truncated: entry.truncated === true || safe?.truncated === true,
          }
        }),
    }
  }

  publishAiContent(
    id: string,
    identity: { executionId: string, vaultPath: string },
    content: Pick<HttpConsoleEntry, 'message' | 'details'>,
  ) {
    if (this.entries.get(id)?.executionId === identity.executionId) {
      this.aiContent.set(id, {
        content: boundContent(content),
        vaultPath: identity.vaultPath,
      })
      this.accountSize(id)
      this.prune()
    }
  }

  clear() {
    this.entries.clear()
    this.aiContent.clear()
    this.sizes.clear()
    this.bytes = 0
    this.emit({ type: 'clear', revision: ++this.revision })
  }

  append(
    entry: Omit<HttpConsoleEntry, 'id' | 'timestamp'> &
      Partial<Pick<HttpConsoleEntry, 'id' | 'timestamp'>>,
    aiContent?: Pick<HttpConsoleEntry, 'message' | 'details'>,
  ) {
    const id = entry.id ?? randomUUID()
    if (aiContent)
      this.aiContent.set(id, { content: boundContent(aiContent) })
    return this.upsert({
      ...entry,
      id,
      timestamp: entry.timestamp ?? Date.now(),
    })
  }

  update(id: string, patch: Partial<HttpConsoleEntry>) {
    this.aiContent.delete(id)
    const existing = this.entries.get(id)
    // Clear must not resurrect requests that were already visible.
    if (existing)
      this.upsert({ ...existing, ...patch, id })
  }

  private accountSize(id: string) {
    const entry = this.entries.get(id)
    if (!entry)
      return
    const safe = this.aiContent.get(id)
    const size = (JSON.stringify(entry).length + (safe ? JSON.stringify(safe).length : 0)) * 2
    this.bytes += size - (this.sizes.get(id) ?? 0)
    this.sizes.set(id, size)
  }

  private upsert(entry: HttpConsoleEntry) {
    const bounded: HttpConsoleEntry = {
      ...entry,
      ...boundContent(entry),
    }
    this.entries.set(entry.id, bounded)
    this.accountSize(entry.id)
    this.prune()
    this.emit({ type: 'upsert', revision: ++this.revision, entry: bounded })
    return bounded.id
  }
}
export const httpConsole = new HttpConsoleJournal()
