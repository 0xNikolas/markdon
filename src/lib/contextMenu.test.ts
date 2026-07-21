import { describe, it, expect } from 'vitest'
import { allowsNativeContextMenu } from './contextMenu'

// Node-environment fakes mirroring the structural slice of HTMLElement the
// predicate reads. `isContentEditable` is the browser-computed effective
// editability (inheritance already resolved), per the ContextMenuTarget doc.

describe('allowsNativeContextMenu', () => {
  it('blocks it on plain chrome (sidebar rows, buttons, panels)', () => {
    // The WKWebView default menu's only entry here is "Reload", which reloads
    // the whole webview and wipes the in-memory Open Files list — the exact
    // footgun this predicate exists to remove.
    expect(allowsNativeContextMenu({ tagName: 'DIV', isContentEditable: false })).toBe(false)
    expect(allowsNativeContextMenu({ tagName: 'BUTTON', isContentEditable: false })).toBe(false)
    expect(allowsNativeContextMenu({ tagName: 'LI', isContentEditable: false })).toBe(false)
  })

  it('blocks it for non-element targets (window, document, text nodes)', () => {
    expect(allowsNativeContextMenu(null)).toBe(false)
    expect(allowsNativeContextMenu(undefined)).toBe(false)
    expect(allowsNativeContextMenu({})).toBe(false) // window/document: no tagName
    expect(allowsNativeContextMenu({ tagName: undefined, isContentEditable: undefined })).toBe(false)
  })

  it('allows it on text inputs and textareas (copy/paste/spellcheck)', () => {
    expect(allowsNativeContextMenu({ tagName: 'INPUT', isContentEditable: false })).toBe(true)
    expect(allowsNativeContextMenu({ tagName: 'TEXTAREA', isContentEditable: false })).toBe(true)
    expect(allowsNativeContextMenu({ tagName: 'input', isContentEditable: false })).toBe(true) // case-insensitive
  })

  it('allows it inside contenteditable regions (the Crepe editor)', () => {
    // The editor root and any descendant: the browser reports effective
    // editability on every element inside the editable region.
    expect(allowsNativeContextMenu({ tagName: 'DIV', isContentEditable: true })).toBe(true)
    expect(allowsNativeContextMenu({ tagName: 'P', isContentEditable: true })).toBe(true)
  })

  it('blocks it inside a contenteditable=false island within the editor', () => {
    // isContentEditable follows inheritance: an explicit ="false" island
    // reports false even though an ancestor is editable.
    expect(allowsNativeContextMenu({ tagName: 'SPAN', isContentEditable: false })).toBe(false)
  })

  it('treats a malformed isContentEditable as not editable (fail closed)', () => {
    expect(allowsNativeContextMenu({ tagName: 'DIV', isContentEditable: 'true' })).toBe(false)
  })
})
