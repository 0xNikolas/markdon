import { invoke } from '@tauri-apps/api/core'
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'
import { get } from 'svelte/store'
import { document, openDoc, markSaved } from './document'

const MD_FILTER = { name: 'Markdown', extensions: ['md', 'markdown'] }

export async function open(): Promise<void> {
  const selected = await openDialog({ filters: [MD_FILTER], multiple: false, directory: false })
  if (typeof selected !== 'string') return // cancelled
  const content = await invoke<string>('read_file', { path: selected })
  openDoc(selected, content)
}

export async function save(): Promise<void> {
  const state = get(document)
  if (state.path === null) return saveAs()
  await invoke('write_file', { path: state.path, contents: state.content })
  markSaved(state.path)
}

export async function saveAs(): Promise<void> {
  const state = get(document)
  const selected = await saveDialog({
    filters: [MD_FILTER],
    defaultPath: state.path ?? 'untitled.md',
  })
  if (selected === null) return // cancelled
  await invoke('write_file', { path: selected, contents: state.content })
  markSaved(selected)
}
