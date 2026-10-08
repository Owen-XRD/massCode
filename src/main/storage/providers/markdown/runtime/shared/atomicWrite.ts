import { randomUUID } from 'node:crypto'
import { open } from 'node:fs/promises'
import path from 'node:path'
import fs from 'fs-extra'
import { markAppWrittenFileAsLocal } from './cloudFiles'

// Publish only a complete, flushed sibling file. A write/flush/rename error
// leaves the last committed destination untouched and remains visible to callers.
export function writeTextFileAtomicSync(filePath: string, content: string): void {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`)
  let descriptor: number | undefined
  try {
    fs.writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' })
    descriptor = fs.openSync(temporary, 'r+')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporary, filePath)
    markAppWrittenFileAsLocal(filePath)
  }
  finally {
    if (descriptor !== undefined)
      fs.closeSync(descriptor)
    if (fs.existsSync(temporary))
      fs.unlinkSync(temporary)
  }
}

export async function writeTextFileAtomic(filePath: string, content: string): Promise<void> {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`)
  try {
    await fs.writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' })
    const handle = await open(temporary, 'r+')
    try {
      await handle.sync()
    }
    finally {
      await handle.close()
    }
    await fs.rename(temporary, filePath)
    markAppWrittenFileAsLocal(filePath)
  }
  finally {
    if (await fs.pathExists(temporary))
      await fs.unlink(temporary)
  }
}
