import { describe, it, expect } from 'vitest'
import { classifyExternalChange } from './fileSync'

describe('classifyExternalChange', () => {
  it('ignores when disk matches the buffer (our own save / no-op)', () => {
    expect(classifyExternalChange({ content: 'x', dirty: false }, 'x', null)).toBe('ignore')
    expect(classifyExternalChange({ content: 'x', dirty: true }, 'x', null)).toBe('ignore')
  })

  it('reloads a clean buffer when disk differs', () => {
    expect(classifyExternalChange({ content: 'old', dirty: false }, 'new', null)).toBe('reload')
  })

  it('flags a conflict when a dirty buffer differs from disk', () => {
    expect(classifyExternalChange({ content: 'mine', dirty: true }, 'theirs', null)).toBe(
      'conflict',
    )
  })

  it('ignores a dirty conflict the user already declined for this exact disk version', () => {
    expect(classifyExternalChange({ content: 'mine', dirty: true }, 'theirs', 'theirs')).toBe(
      'ignore',
    )
  })

  it('re-prompts when a new on-disk version arrives after a prior decline', () => {
    expect(classifyExternalChange({ content: 'mine', dirty: true }, 'newer', 'theirs')).toBe(
      'conflict',
    )
  })
})
