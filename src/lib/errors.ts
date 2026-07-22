import { writable, type Writable } from 'svelte/store'

export const errorMessage: Writable<string | null> = writable(null)

export function reportError(msg: string): void {
  errorMessage.set(msg)
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
}

export function clearNotice(): void {
  notice.set(null)
}
