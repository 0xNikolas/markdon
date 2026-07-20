import { invoke } from '@tauri-apps/api/core'
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'
import { get } from 'svelte/store'
import { doc, openDoc, markSaved } from './doc'
import { reportError } from './errors'

const MD_FILTER = { name: 'Markdown', extensions: ['md', 'markdown'] }

export async function openPath(path: string): Promise<void> {
  try {
    const content = await invoke<string>('read_file', { path })
    openDoc(path, content)
  } catch (e) {
    reportError(`Could not open file: ${String(e)}`)
  }
}

export async function open(): Promise<void> {
  const selected = await openDialog({ filters: [MD_FILTER], multiple: false, directory: false })
  if (typeof selected !== 'string') return // cancelled
  await openPath(selected)
}

export async function save(): Promise<void> {
  const state = get(doc)
  if (state.path === null) return saveAs()
  try {
    await invoke('write_file', { path: state.path, contents: state.content })
    markSaved(state.path)
  } catch (e) {
    reportError(`Could not save file: ${String(e)}`)
  }
}

export async function saveAs(): Promise<void> {
  const state = get(doc)
  const selected = await saveDialog({
    filters: [MD_FILTER],
    defaultPath: state.path ?? 'untitled.md',
  })
  if (selected === null) return // cancelled
  try {
    await invoke('write_file', { path: selected, contents: state.content })
    markSaved(selected)
  } catch (e) {
    reportError(`Could not save file: ${String(e)}`)
  }
}
