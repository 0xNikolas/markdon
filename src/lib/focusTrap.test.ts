import { describe, it, expect, vi } from 'vitest'
import { dialogDismissHandlers } from './focusTrap'

// Node-environment fakes mirroring the structural slice of KeyboardEvent /
// MouseEvent the handlers read — no jsdom (house rule), same approach as
// contextMenu.test.ts.

describe('dialogDismissHandlers', () => {
  it('onKeydown closes and stops propagation on Escape', () => {
    const close = vi.fn()
    const { onKeydown } = dialogDismissHandlers(close)
    const stopPropagation = vi.fn()
    onKeydown({ key: 'Escape', stopPropagation } as unknown as KeyboardEvent)
    expect(close).toHaveBeenCalledTimes(1)
    expect(stopPropagation).toHaveBeenCalledTimes(1)
  })

  it('onKeydown ignores any other key', () => {
    const close = vi.fn()
    const { onKeydown } = dialogDismissHandlers(close)
    const stopPropagation = vi.fn()
    onKeydown({ key: 'Enter', stopPropagation } as unknown as KeyboardEvent)
    expect(close).not.toHaveBeenCalled()
    expect(stopPropagation).not.toHaveBeenCalled()
  })

  it('onBackdropClick closes when the click lands on the backdrop itself', () => {
    const close = vi.fn()
    const { onBackdropClick } = dialogDismissHandlers(close)
    const backdrop = {}
    onBackdropClick({ target: backdrop, currentTarget: backdrop } as unknown as MouseEvent)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('onBackdropClick does nothing when the click bubbled up from inside the dialog', () => {
    const close = vi.fn()
    const { onBackdropClick } = dialogDismissHandlers(close)
    onBackdropClick({ target: {}, currentTarget: {} } as unknown as MouseEvent)
    expect(close).not.toHaveBeenCalled()
  })
})
