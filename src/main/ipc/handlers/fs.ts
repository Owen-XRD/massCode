import type {
  ImportMarkdownFolderResponse,
  NoteExportResponse,
  NoteFolderSiteExportPrepareResponse,
  NoteFolderSiteExportResponse,
} from '../../types/ipc'
import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { join, parse } from 'node:path'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import {
  ensureDirSync,
  writeFileSync,
} from 'fs-extra'
import slash from 'slash'
import {
  changeFolderIconWithUndo,
  parseFolderIconSetPayload,
  parseFolderIconWritePayload,
  setFolderIcon,
  undoFolderIconChange,
  writeFolderIcon,
} from '../../folderIcons'
import { readMarkdownFolder } from '../../import/notes/readFolder'
import { pickNoteImage, writeCapturedNoteImage } from '../../noteImagePicker'
import { exportNote, parseNoteExportPayload } from '../../notesExport'
import {
  exportNoteFolderSite,
  parseNoteFolderSiteExportPayload,
  parseNoteFolderSiteExportPreparePayload,
  prepareNoteFolderSiteExport,
} from '../../notesFolderSiteExport'
import { exportRenderedArtifact } from '../../renderedArtifactExport'
import { parseNotesAssetWritePayload } from '../../storage/providers/markdown/notes/runtime'
import { store } from '../../store'

const ASSETS_DIR = 'assets'

// A short, URL- and filesystem-safe id for asset filenames. Uses the
// built-in crypto module so the main process keeps no dependency on the
// ESM-only nanoid, which cannot be `require`d from the compiled CommonJS
// build.
function generateAssetId() {
  return randomBytes(12).toString('base64url')
}

export function registerFsHandlers() {
  ipcMain.handle('fs:export-rendered-artifact', (_, payload: unknown) =>
    exportRenderedArtifact(payload))
  ipcMain.handle('fs:export-note', async (_, payload: unknown) => {
    const parsedPayload = parseNoteExportPayload(payload)
    if (!parsedPayload) {
      throw new TypeError('Invalid note export payload')
    }

    return exportNote(parsedPayload) satisfies Promise<NoteExportResponse>
  })

  ipcMain.handle(
    'fs:prepare-note-folder-site-export',
    (_, payload: unknown) => {
      const parsedPayload = parseNoteFolderSiteExportPreparePayload(payload)
      if (!parsedPayload) {
        throw new TypeError('Invalid Notes folder site export payload')
      }

      return prepareNoteFolderSiteExport(
        parsedPayload,
      ) satisfies NoteFolderSiteExportPrepareResponse
    },
  )

  ipcMain.handle('fs:export-note-folder-site', async (_, payload: unknown) => {
    const parsedPayload = parseNoteFolderSiteExportPayload(payload)
    if (!parsedPayload) {
      throw new TypeError('Invalid Notes folder site export payload')
    }

    return exportNoteFolderSite(
      parsedPayload,
    ) satisfies Promise<NoteFolderSiteExportResponse>
  })

  ipcMain.handle('fs:folder-icon:write', async (_, payload: unknown) => {
    const parsedPayload = parseFolderIconWritePayload(payload)
    if (!parsedPayload)
      throw new TypeError('Invalid folder icon payload')

    return writeFolderIcon(parsedPayload)
  })
  ipcMain.handle('fs:folder-icon:change', (event, payload: unknown) =>
    changeFolderIconWithUndo(
      payload,
      BrowserWindow.fromWebContents(event.sender) ?? undefined,
    ))
  ipcMain.handle('fs:folder-icon:undo', (_, payload: { id?: unknown }) =>
    undoFolderIconChange(payload?.id))

  ipcMain.handle('fs:folder-icon:set', async (_, payload: unknown) => {
    const parsedPayload = parseFolderIconSetPayload(payload)
    if (!parsedPayload)
      throw new TypeError('Invalid folder icon payload')

    await setFolderIcon(parsedPayload)
  })

  ipcMain.handle('fs:assets', (event, { buffer, fileName }) => {
    const storagePath = store.preferences.get('storage.rootPath') as string

    return new Promise((resolve, reject) => {
      try {
        const assetsPath = join(storagePath, ASSETS_DIR)

        const { ext } = parse(fileName)
        const name = `${generateAssetId()}${ext}`
        const dest = join(assetsPath, name)

        ensureDirSync(assetsPath)
        writeFileSync(dest, Buffer.from(buffer))

        resolve(slash(join(ASSETS_DIR, name)))
      }
      catch (error) {
        reject(error)
      }
    })
  })

  ipcMain.handle('fs:pick-note-image', (event, payload: unknown) =>
    pickNoteImage(
      payload,
      BrowserWindow.fromWebContents(event.sender) ?? undefined,
    ))

  ipcMain.handle('fs:notes-asset', async (event, payload: unknown) => {
    const parsedPayload = parseNotesAssetWritePayload(payload)
    if (!parsedPayload) {
      throw new TypeError('Invalid Notes asset payload')
    }

    return writeCapturedNoteImage(
      (payload as { vault?: unknown }).vault,
      parsedPayload.buffer,
      parsedPayload.ext,
    )
  })

  ipcMain.handle('fs:import-markdown-folder', async () => {
    return new Promise<ImportMarkdownFolderResponse>((resolve) => {
      const window = BrowserWindow.getFocusedWindow()
      if (!window) {
        resolve({ canceled: true, files: [], warnings: [] })
        return
      }

      const result = dialog.showOpenDialogSync(window, {
        properties: ['openDirectory'],
      })

      if (!result?.[0]) {
        resolve({ canceled: true, files: [], warnings: [] })
        return
      }

      resolve(readMarkdownFolder(result[0]))
    })
  })
}
