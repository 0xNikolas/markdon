/**
 * Dependency-free Svelte action that traps Tab focus inside `node` while it
 * is mounted (used by the Settings modal and the unsaved-changes guard
 * modal). The Tab-cycling keydown handler is the PRIMARY containment
 * mechanism (it works regardless of platform support); `inert` on the
 * background is an enhancement layered on top.
 *
 * Initial focus normally lands on the first focusable element inside `node`.
 * Mark a different element with `data-autofocus` (e.g. a Cancel button) to
 * override that -- it's used instead as long as it isn't disabled/hidden.
 *
 * Not unit-tested: it's DOM-only (focus, `inert`, keyboard events) and the
 * project's vitest config runs `environment: 'node'` with no jsdom/component
 * test infra (house rule) — covered by the manual-smoke checklist instead.
 */
const FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

export function focusTrap(node: HTMLElement): { destroy(): void } {
  const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const appRoot = document.querySelector('main.app')
  appRoot?.setAttribute('inert', '')

  const focusables = (): HTMLElement[] =>
    Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
      (el) => !el.hasAttribute('disabled') && el.offsetParent !== null,
    )

  function onKeydown(e: KeyboardEvent) {
    if (e.key !== 'Tab') return
    const els = focusables()
    if (els.length === 0) return
    const first = els[0]
    const last = els[els.length - 1]
    const active = document.activeElement
    if (e.shiftKey && (active === first || !node.contains(active))) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && (active === last || !node.contains(active))) {
      e.preventDefault()
      first.focus()
    }
  }

  node.addEventListener('keydown', onKeydown)
  const autofocus = node.querySelector<HTMLElement>('[data-autofocus]')
  const initial = autofocus && !autofocus.hasAttribute('disabled') && autofocus.offsetParent !== null
    ? autofocus
    : focusables()[0]
  initial?.focus()

  return {
    destroy() {
      node.removeEventListener('keydown', onKeydown)
      appRoot?.removeAttribute('inert')
      prev?.focus()
    },
  }
}

/**
 * The Escape-key + click-outside-to-close pair repeated across every modal
 * (HistoryModal, SettingsModal, and — Escape-only — NameModal, MoveToModal):
 * Escape on the dialog stops propagation (so a window-level Escape handler
 * elsewhere doesn't also fire) and closes; a backdrop click only closes when
 * it lands on the backdrop itself, not one that bubbled up from inside the
 * dialog (`target === currentTarget`).
 */
export function dialogDismissHandlers(close: () => void): {
  onKeydown: (e: KeyboardEvent) => void
  onBackdropClick: (e: MouseEvent) => void
} {
  return {
    onKeydown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    },
    onBackdropClick(e: MouseEvent) {
      if (e.target === e.currentTarget) close()
    },
  }
}
