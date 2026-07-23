import { describe, it, expect } from 'vitest'
// The launcher's pure logic lives in a plain .mjs (so scripts/md can import it
// without a build step); this test drives that same module.
import { buildArgv, binaryCandidates, findBinary, MdError, USAGE } from '../../scripts/mdCli.mjs'

/** A `probe` stand-in backed by a plain map of absolute path -> kind. */
function probeFrom(map: Record<string, 'file' | 'dir'>) {
  return (absPath: string) => map[absPath] ?? null
}

describe('buildArgv', () => {
  it('routes a file to a positional argv entry (absolute)', () => {
    const probe = probeFrom({ '/work/notes.md': 'file' })
    expect(buildArgv(['notes.md'], { cwd: '/work', probe })).toEqual(['/work/notes.md'])
  })

  it('routes a directory to `--workspace <absdir>`', () => {
    const probe = probeFrom({ '/work/project': 'dir' })
    expect(buildArgv(['./project'], { cwd: '/work', probe })).toEqual([
      '--workspace',
      '/work/project',
    ])
  })

  it('resolves relative paths against cwd', () => {
    const probe = probeFrom({ '/a/b/c/notes.md': 'file' })
    expect(buildArgv(['../c/notes.md'], { cwd: '/a/b/d', probe })).toEqual(['/a/b/c/notes.md'])
  })

  it('keeps an already-absolute path as given', () => {
    const probe = probeFrom({ '/abs/notes.md': 'file' })
    expect(buildArgv(['/abs/notes.md'], { cwd: '/work', probe })).toEqual(['/abs/notes.md'])
  })

  it('combines several files with a single workspace folder', () => {
    const probe = probeFrom({
      '/w/a.md': 'file',
      '/w/b.md': 'file',
      '/w/docs': 'dir',
    })
    expect(buildArgv(['a.md', 'b.md', './docs'], { cwd: '/w', probe })).toEqual([
      '--workspace',
      '/w/docs',
      '/w/a.md',
      '/w/b.md',
    ])
  })

  it('errors (no-path) when no path is given', () => {
    const probe = probeFrom({})
    expect(() => buildArgv([], { cwd: '/w', probe })).toThrow(MdError)
    try {
      buildArgv([], { cwd: '/w', probe })
    } catch (e) {
      expect((e as MdError).code).toBe('no-path')
    }
  })

  it('errors (not-found) when a path does not exist', () => {
    const probe = probeFrom({})
    try {
      buildArgv(['ghost.md'], { cwd: '/w', probe })
      throw new Error('expected throw')
    } catch (e) {
      expect((e as MdError).code).toBe('not-found')
    }
  })

  it('errors (multi-dir) when more than one directory is given', () => {
    const probe = probeFrom({ '/w/one': 'dir', '/w/two': 'dir' })
    try {
      buildArgv(['one', 'two'], { cwd: '/w', probe })
      throw new Error('expected throw')
    } catch (e) {
      expect((e as MdError).code).toBe('multi-dir')
    }
  })
})

describe('binaryCandidates / findBinary', () => {
  it('is macOS-first: /Applications then ~/Applications', () => {
    expect(binaryCandidates({ env: {}, home: '/Users/x' })).toEqual([
      '/Applications/Markdon.app/Contents/MacOS/app',
      '/Users/x/Applications/Markdon.app/Contents/MacOS/app',
    ])
  })

  it('MARKDON_BIN overrides and short-circuits the search', () => {
    expect(binaryCandidates({ env: { MARKDON_BIN: '/custom/app' }, home: '/Users/x' })).toEqual([
      '/custom/app',
    ])
  })

  it('returns the first existing candidate', () => {
    const bin = findBinary({
      env: {},
      home: '/Users/x',
      exists: (p) => p === '/Users/x/Applications/Markdon.app/Contents/MacOS/app',
    })
    expect(bin).toBe('/Users/x/Applications/Markdon.app/Contents/MacOS/app')
  })

  it('errors (no-binary) when nothing is found', () => {
    try {
      findBinary({ env: {}, home: '/Users/x', exists: () => false })
      throw new Error('expected throw')
    } catch (e) {
      expect((e as MdError).code).toBe('no-binary')
    }
  })
})

describe('USAGE', () => {
  it('documents the file and folder examples', () => {
    expect(USAGE).toContain('md notes.md')
    expect(USAGE).toContain('md ./project')
    expect(USAGE).toContain('MARKDON_BIN')
  })
})
