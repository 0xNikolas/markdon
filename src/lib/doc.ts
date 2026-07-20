import { writable, type Writable } from 'svelte/store'

export interface DocState {
  path: string | null
  content: string
  /** Exactly what our last read/write put on disk. Dirty ⇔ content differs. */
  savedContent: string
  loadId: number
}

const initial: DocState = { path: null, content: '', savedContent: '', loadId: 0 }

export const doc: Writable<DocState> = writable(initial)

/** Derived, never stored: the buffer differs from what we last synced to disk. */
export function isDirty(s: Pick<DocState, 'content' | 'savedContent'>): boolean {
  return s.content !== s.savedContent
}

export function openDoc(path: string, content: string): void {
  doc.update((s) => ({ path, content, savedContent: content, loadId: s.loadId + 1 }))
}

export function newDoc(): void {
  doc.update((s) => ({ path: null, content: '', savedContent: '', loadId: s.loadId + 1 }))
}

export function edit(content: string): void {
  doc.update((s) => ({ ...s, content }))
}

/** Record a completed write: `savedContent` is what the write actually contained. */
export function markSaved(path: string, savedContent: string): void {
  doc.update((s) => ({ ...s, path, savedContent }))
}
