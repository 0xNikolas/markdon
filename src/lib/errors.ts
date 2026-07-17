import { writable, type Writable } from 'svelte/store'

export const errorMessage: Writable<string | null> = writable(null)

export function reportError(msg: string): void {
  errorMessage.set(msg)
}

export function clearError(): void {
  errorMessage.set(null)
}
