import { writable, type Writable } from 'svelte/store'
import { logError, logInfo } from './logging'

export const errorMessage: Writable<string | null> = writable(null)

export function reportError(msg: string): void {
  errorMessage.set(msg)
  logError(msg) // every user-visible error also leaves a trace in markdon.log
}

export function clearError(): void {
  errorMessage.set(null)
}

/**
 * Informational (non-error) banner text. Used for benign consequences the user
 * should still notice — e.g. deleting the open file detaches it to an unsaved
 * Untitled document. Rendered with info styling, distinct from the red error
 * banner, so a routine outcome never looks like a failure.
 */
export const notice: Writable<string | null> = writable(null)

export function reportNotice(msg: string): void {
  notice.set(msg)
  logInfo(msg)
}

export function clearNotice(): void {
  notice.set(null)
}
