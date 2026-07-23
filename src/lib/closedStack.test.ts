import { describe, it, expect, beforeEach } from 'vitest'
import { get } from 'svelte/store'
import {
  pushClosed,
  popClosed,
  MAX_CLOSED,
  closedStack,
  recordClosed,
  takeClosed,
  clearClosed,
  type ClosedEntry,
} from './closedStack'
import { workspace } from './workspace'
import { dir } from './test-support/workspaceFixtures'

const e = (path: string, index = 0): ClosedEntry => ({ path, index })

beforeEach(() => {
  workspace.set({ root: '/ws', tree: dir('ws', '/ws') })
  clearClosed()
})

describe('pushClosed', () => {
  it('appends newest last', () => {
    expect(pushClosed([e('/a.md', 0)], e('/b.md', 1))).toEqual([e('/a.md', 0), e('/b.md', 1)])
  })

  it('re-closing a path replaces its old entry (one slot per path, newest wins)', () => {
    const stack = [e('/a.md', 0), e('/b.md', 1)]
    expect(pushClosed(stack, e('/a.md', 2))).toEqual([e('/b.md', 1), e('/a.md', 2)])
  })

  it('caps at MAX_CLOSED, dropping the OLDEST entries', () => {
    let stack: ClosedEntry[] = []
    for (let i = 0; i < MAX_CLOSED + 3; i++) stack = pushClosed(stack, e(`/f${i}.md`, i))
    expect(stack).toHaveLength(MAX_CLOSED)
    expect(stack[0]).toEqual(e('/f3.md', 3)) // 0..2 dropped
    expect(stack[stack.length - 1]).toEqual(e(`/f${MAX_CLOSED + 2}.md`, MAX_CLOSED + 2))
  })

  it('does not mutate the input stack', () => {
    const stack = [e('/a.md', 0)]
    pushClosed(stack, e('/b.md', 1))
    expect(stack).toEqual([e('/a.md', 0)])
  })
})

describe('popClosed', () => {
  it('returns null on an empty stack', () => {
    expect(popClosed([])).toBeNull()
  })

  it('splits off the newest entry, leaving the rest intact', () => {
    const popped = popClosed([e('/a.md', 0), e('/b.md', 1)])
    expect(popped?.entry).toEqual(e('/b.md', 1))
    expect(popped?.rest).toEqual([e('/a.md', 0)])
  })
})

describe('recordClosed / takeClosed (the store wrappers)', () => {
  it('LIFO: the most recently recorded close pops first', () => {
    recordClosed('/ws/a.md', 0)
    recordClosed('/ws/b.md', 1)
    expect(takeClosed()).toEqual(e('/ws/b.md', 1))
    expect(takeClosed()).toEqual(e('/ws/a.md', 0))
    expect(takeClosed()).toBeNull()
  })

  it('take consumes: a popped entry is gone from the store', () => {
    recordClosed('/ws/a.md', 0)
    takeClosed()
    expect(get(closedStack)).toEqual([])
  })
})

describe('workspace root changes clear the stack', () => {
  it('clears when a different root is adopted', () => {
    recordClosed('/ws/a.md', 0)
    workspace.set({ root: '/other', tree: dir('other', '/other') })
    expect(get(closedStack)).toEqual([])
    expect(takeClosed()).toBeNull()
  })

  it('keeps the stack on a same-root refresh', () => {
    recordClosed('/ws/a.md', 0)
    workspace.set({ root: '/ws', tree: dir('ws', '/ws') }) // refreshWorkspace shape
    expect(get(closedStack)).toEqual([e('/ws/a.md', 0)])
  })
})
