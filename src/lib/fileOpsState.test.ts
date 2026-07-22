import { describe, it, expect, beforeEach } from 'vitest'
import { get } from 'svelte/store'
import {
  selection,
  focused,
  clipboard,
  focusRow,
  cutSelection,
  clearSelection,
} from './fileOpsState'
import { workspace } from './workspace'
import { dir, tree } from './test-support/workspaceFixtures'

beforeEach(() => {
  selection.set(new Set())
  focused.set(null)
  clipboard.set(null)
  workspace.set({ root: '/ws', tree })
})

describe('workspace root changes clear file-ops state', () => {
  it('resets selection, focused, and clipboard when the root changes', () => {
    focusRow('/ws/docs/note.md')
    cutSelection()
    expect(get(selection).size).toBe(1)
    expect(get(focused)).toBe('/ws/docs/note.md')
    expect(get(clipboard)).not.toBeNull()

    // A different workspace is opened (Open Folder / restore) -- same shape
    // of update `adopt()` performs in workspace.ts.
    workspace.set({ root: '/other', tree: dir('other', '/other') })

    expect(get(selection).size).toBe(0)
    expect(get(focused)).toBeNull()
    expect(get(clipboard)).toBeNull()
  })

  it('does not clear on a same-root refresh (e.g. refreshWorkspace)', () => {
    focusRow('/ws/docs/note.md')
    cutSelection()

    // Same root, new tree object -- what refreshWorkspace's adopt() does.
    workspace.set({ root: '/ws', tree: dir('ws', '/ws') })

    expect(get(selection).size).toBe(1)
    expect(get(focused)).toBe('/ws/docs/note.md')
    expect(get(clipboard)).not.toBeNull()
  })
})

describe('clearSelection', () => {
  it('empties the selection and drops the focus anchor', () => {
    selection.set(new Set(['/ws/a.md', '/ws/b.md']))
    focused.set('/ws/a.md')
    clearSelection()
    expect(get(selection).size).toBe(0)
    expect(get(focused)).toBeNull()
  })
})
