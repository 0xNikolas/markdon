import { invoke } from '@tauri-apps/api/core'
import { writable, type Writable } from 'svelte/store'

/**
 * File History: the app-managed local version store lives in Rust
 * (src-tauri/src/history.rs). This module is the thin frontend surface — the
 * stores the HistoryModal renders from, best-effort record wrappers, and the
 * pure formatters (unit-tested) that turn Rust's raw ms/bytes into row labels.
 *
 * The path always comes from the doc store; this module never builds one. Rust
 * derives the store bucket from the ensure()'d path, so the webview can neither
 * name a store path nor read a version it wasn't handed by list_history.
 */

/** One recorded version. Mirrors src-tauri/src/history.rs `Entry`. */
export interface HistoryEntry {
  /** On-disk snapshot filename; the handle passed back to read_history_version. */
  id: string
  /** UNIX-epoch milliseconds the snapshot was taken. */
  ts: number
  /** Byte length of the snapshot content. */
  size: number
  /** SHA-256 hex of the content (used server-side for dedupe). */
  hash: string
  /** One-line preview: first heading, else first ~80 chars. */
  preview: string
  /** What caused the snapshot. */
  trigger: 'save' | 'external' | 'revert'
}

/** Versions for the open file, newest-first. Loaded when the modal opens. */
export const versions: Writable<HistoryEntry[]> = writable([])
/** The id of the version currently previewed in the modal (null = none). */
export const selectedVersionId: Writable<string | null> = writable(null)

/** Load the version list for `path` (newest-first, straight from Rust). */
export async function loadVersions(path: string): Promise<HistoryEntry[]> {
  const list = await invoke<HistoryEntry[]>('list_history', { path })
  versions.set(list)
  return list
}

/** Read one version's full content for the read-only preview. */
export async function readVersion(path: string, id: string): Promise<string> {
  return invoke<string>('read_history_version', { path, id })
}

/**
 * Best-effort snapshot after a change lands on disk. A history failure must
 * NEVER surface as a save failure, so every wrapper swallows (and logs) a
 * rejected invoke rather than throwing. Rust re-reads the file itself — content
 * is never sent from here.
 */
async function record(path: string, trigger: HistoryEntry['trigger']): Promise<void> {
  try {
    await invoke('record_history', { path, trigger })
  } catch (e) {
    console.warn(`history: could not record ${trigger} snapshot`, e)
  }
}

/** After a successful save/saveAs. */
export function recordSave(path: string): Promise<void> {
  return record(path, 'save')
}

/** After silently adopting an external on-disk change (recoverable). */
export function recordExternal(path: string): Promise<void> {
  return record(path, 'external')
}

/** Immediately before applying a revert — captures the pre-revert disk state. */
export function recordRevert(path: string): Promise<void> {
  return record(path, 'revert')
}

// -- pure formatters (unit-tested) -------------------------------------------

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * Coarse relative time: 'just now' (< 1m), 'Nm ago', 'Nh ago', 'Nd ago'.
 * A future `ts` (clock skew) clamps to 'just now' rather than showing negatives.
 */
export function relativeTime(ts: number, now: number): string {
  const diff = now - ts
  if (diff < MINUTE) return 'just now'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`
  return `${Math.floor(diff / DAY)}d ago`
}

/**
 * Human byte count: integer bytes under 1 KB, else one decimal in KB/MB.
 * (Used for both absolute sizes and, via {@link sizeDelta}, signed deltas.)
 */
export function formatBytes(n: number): string {
  const abs = Math.abs(n)
  if (abs < 1024) return `${n} B`
  if (abs < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Signed size change vs the previous (older) version: '+142 B', '-1.2 KB'.
 * The first version (no previous) and a zero delta both render as an em dash,
 * so the column only ever shows a real change.
 */
export function sizeDelta(bytes: number, prevBytes: number | null): string {
  if (prevBytes === null) return '—'
  const delta = bytes - prevBytes
  if (delta === 0) return '—'
  const sign = delta > 0 ? '+' : '-'
  return `${sign}${formatBytes(Math.abs(delta))}`
}

/** Row badge label for a trigger. */
export function triggerLabel(trigger: HistoryEntry['trigger']): string {
  switch (trigger) {
    case 'external':
      return 'External'
    case 'revert':
      return 'Reverted'
    default:
      return 'Saved'
  }
}
