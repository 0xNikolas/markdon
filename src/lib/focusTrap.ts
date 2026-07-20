/**
 * Dependency-free Svelte action that traps Tab focus inside `node` while it
 * is mounted (the Settings modal dialog). The Tab-cycling keydown handler is
 * the PRIMARY containment mechanism (it works regardless of platform
 * support); `inert` on the background is an enhancement layered on top.
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
  focusables()[0]?.focus()

  return {
    destroy() {
      node.removeEventListener('keydown', onKeydown)
      appRoot?.removeAttribute('inert')
      prev?.focus()
    },
  }
}
