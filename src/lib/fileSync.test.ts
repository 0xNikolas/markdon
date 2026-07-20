import { describe, it, expect } from 'vitest'
import { classifyExternalChange } from './fileSync'

describe('classifyExternalChange', () => {
  it('ignores when disk matches the buffer (no real change)', () => {
    expect(
      classifyExternalChange({ content: 'x', savedContent: 'x' }, 'x', null),
    ).toBe('ignore')
    expect(
      classifyExternalChange({ content: 'x', savedContent: 'old' }, 'x', null),
    ).toBe('ignore')
  })

  it('ignores our own save landing while the user kept typing', () => {
    // We wrote 'v1'; user has since typed 'v2'. The watcher fires for our own
    // write — disk equals savedContent, so nothing external happened.
    expect(
      classifyExternalChange({ content: 'v2', savedContent: 'v1' }, 'v1', null),
    ).toBe('ignore')
  })

  it('reloads a clean buffer when disk differs', () => {
    expect(
      classifyExternalChange({ content: 'old', savedContent: 'old' }, 'new', null),
    ).toBe('reload')
  })

  it('flags a conflict when a dirty buffer differs from disk', () => {
    expect(
      classifyExternalChange({ content: 'mine', savedContent: 'base' }, 'theirs', null),
    ).toBe('conflict')
  })

  it('ignores a dirty conflict the user already declined for this exact disk version', () => {
    expect(
      classifyExternalChange({ content: 'mine', savedContent: 'base' }, 'theirs', 'theirs'),
    ).toBe('ignore')
  })

  it('re-prompts when a new on-disk version arrives after a prior decline', () => {
    expect(
      classifyExternalChange({ content: 'mine', savedContent: 'base' }, 'newer', 'theirs'),
    ).toBe('conflict')
  })
})
