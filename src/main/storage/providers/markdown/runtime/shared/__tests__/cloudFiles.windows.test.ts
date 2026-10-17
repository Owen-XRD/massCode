import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import fs from 'fs-extra'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getFileAvailability, primeDatalessChecks, resetCloudFileExemptions } from '../cloudFiles'

describe.skipIf(process.platform !== 'win32')('windows file availability using native attributes', () => {
  let directory: string
  let originalSystemRoot: string | undefined
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'masscode-native-'))
    originalSystemRoot = process.env.SystemRoot
    resetCloudFileExemptions()
  })
  afterEach(() => {
    if (originalSystemRoot === undefined)
      delete process.env.SystemRoot
    else
      process.env.SystemRoot = originalSystemRoot
    resetCloudFileExemptions()
    fs.removeSync(directory)
  })
  function setAttributes(file: string, attributes: number) {
    const command = `[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [IO.File]::SetAttributes([Console]::In.ReadToEnd(), [IO.FileAttributes]${attributes})`
    execFileSync(path.join(originalSystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { input: file, windowsHide: true, timeout: 3000 })
  }
  it('accepts resident Unicode files and invalidates attributes when a local file changes', () => {
    const file = path.join(directory, '中文 local.md')
    fs.writeFileSync(file, 'resident')
    expect(fs.statSync(file).blocks).toBe(0)
    primeDatalessChecks([file])
    expect(getFileAvailability(file).isCloudPlaceholder).toBe(false)
    // OFFLINE on our own disposable file exercises metadata only; never read its body.
    setAttributes(file, 0x1000)
    expect(getFileAvailability(file).isCloudPlaceholder).toBe(true)
    setAttributes(file, 0x80)
    expect(getFileAvailability(file).isCloudPlaceholder).toBe(false)
  })
  it('fails closed after a probe error and recovers without a process restart', () => {
    const file = path.join(directory, 'recovery.md')
    fs.writeFileSync(file, 'resident')
    process.env.SystemRoot = path.join(directory, 'missing-windows')
    expect(getFileAvailability(file).isCloudPlaceholder).toBe(true)
    process.env.SystemRoot = originalSystemRoot
    expect(getFileAvailability(file).isCloudPlaceholder).toBe(false)
    fs.removeSync(file)
    expect(getFileAvailability(file).exists).toBe(false)
    fs.writeFileSync(file, 'replacement')
    expect(getFileAvailability(file).isCloudPlaceholder).toBe(false)
  })
})
