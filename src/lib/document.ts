import { writable, type Writable } from 'svelte/store'

export interface DocState {
  path: string | null
  content: string
  dirty: boolean
  loadId: number
}

const initial: DocState = { path: null, content: '', dirty: false, loadId: 0 }

export const document: Writable<DocState> = writable(initial)

export function openDoc(path: string, content: string): void {
  document.update((s) => ({ path, content, dirty: false, loadId: s.loadId + 1 }))
}

export function newDoc(): void {
  document.update((s) => ({ path: null, content: '', dirty: false, loadId: s.loadId + 1 }))
}

export function edit(content: string): void {
  document.update((s) => ({ ...s, content, dirty: true }))
}

export function markSaved(path: string): void {
  document.update((s) => ({ ...s, path, dirty: false }))
}
