import { describe, it, expect } from 'vitest'
import { pathHint, type CliStatus } from './cliInstall'

const status = (over: Partial<CliStatus> = {}): CliStatus => ({
  installed: false,
  path: '/usr/local/bin/md',
  on_path: true,
  ...over,
})

describe('pathHint', () => {
  it('is null when the shim directory is on PATH', () => {
    expect(pathHint(status({ on_path: true }))).toBeNull()
  })

  it('advises adding the shim directory to PATH when it is not on PATH', () => {
    const hint = pathHint(status({ path: '/home/u/.local/bin/md', on_path: false }))
    expect(hint).toBe('Add /home/u/.local/bin to your PATH to use `md`.')
  })

  it('strips only the trailing /md segment to name the directory', () => {
    // A path whose earlier segments resemble the basename must keep them.
    const hint = pathHint(status({ path: '/opt/md/tools/bin/md', on_path: false }))
    expect(hint).toBe('Add /opt/md/tools/bin to your PATH to use `md`.')
  })

  it('is null when there is no known path', () => {
    expect(pathHint(status({ path: null, on_path: false }))).toBeNull()
  })

  it('advises regardless of installed state (pre-install target still helps)', () => {
    expect(pathHint(status({ installed: false, on_path: false }))).not.toBeNull()
    expect(pathHint(status({ installed: true, on_path: false }))).not.toBeNull()
  })
})
