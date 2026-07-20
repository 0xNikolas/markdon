import { writable, type Writable } from 'svelte/store'

export interface DocState {
  path: string | null
  content: string
  /** Exactly what our last read/write put on disk. Dirty ⇔ content differs. */
  savedContent: string
  /** OS-opened files start read-only; lifted per-document via enableEditing. */
  readonly: boolean
  loadId: number
}

const initial: DocState = { path: null, content: '', savedContent: '', readonly: false, loadId: 0 }

export const doc: Writable<DocState> = writable(initial)

/** Derived, never stored: the buffer differs from what we last synced to disk. */
export function isDirty(s: Pick<DocState, 'content' | 'savedContent'>): boolean {
  return s.content !== s.savedContent
}

export function openDoc(path: string, content: string, readonly = false): void {
  doc.update((s) => ({ path, content, savedContent: content, readonly, loadId: s.loadId + 1 }))
}

export function newDoc(): void {
  doc.update((s) => ({ path: null, content: '', savedContent: '', readonly: false, loadId: s.loadId + 1 }))
}

export function edit(content: string): void {
  // A readonly buffer must stay clean even if the editor leaks an update event.
  doc.update((s) => (s.readonly ? s : { ...s, content }))
}

/** Record a completed write: `savedContent` is what the write actually contained. */
export function markSaved(path: string, savedContent: string): void {
  doc.update((s) => ({ ...s, path, savedContent }))
}

export function enableEditing(): void {
  doc.update((s) => ({ ...s, readonly: false }))
}
