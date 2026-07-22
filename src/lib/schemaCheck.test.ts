import { describe, it, expect, beforeEach, vi } from 'vitest'
import { get } from 'svelte/store'
import { logPluginMocks } from './test-support/tauriMocks'
import { missingNodeGroups, REQUIRED_NODE_GROUPS } from './schemaCheck'

const FULL_NODE_SET = ['doc', 'text', 'paragraph', 'image-block', 'heading', 'blockquote']

describe('missingNodeGroups', () => {
  it('returns [] for a schema containing every required node', () => {
    expect(missingNodeGroups(FULL_NODE_SET)).toEqual([])
  })

  it("accepts 'image' alone for the image group (uploader fallback parity)", () => {
    expect(missingNodeGroups(['doc', 'text', 'paragraph', 'image'])).toEqual([])
  })

  it('reports a missing image group with both accepted names', () => {
    expect(missingNodeGroups(['doc', 'text', 'paragraph'])).toEqual(['image-block|image'])
  })

  it('reports every unsatisfied group, in declaration order', () => {
    expect(missingNodeGroups([])).toEqual(REQUIRED_NODE_GROUPS.map((g) => g.join('|')))
  })

  it('honors a custom groups parameter', () => {
    expect(missingNodeGroups(['a'], [['a'], ['b', 'c']])).toEqual(['b|c'])
  })
})

/**
 * checkEditorSchema keeps module state (the banner-once guard), so each test
 * gets a fresh module registry — and must read `errorMessage` from the SAME
 * registry, or the store the module wrote to isn't the one asserted on.
 */
async function freshModules() {
  vi.resetModules()
  const [{ checkEditorSchema }, { errorMessage, clearError }] = await Promise.all([
    import('./schemaCheck'),
    import('./errors'),
  ])
  return { checkEditorSchema, errorMessage, clearError }
}

const goodSchema = () => ({
  nodes: Object.fromEntries(FULL_NODE_SET.map((n) => [n, {}])),
})

const imagelessSchema = () => ({
  nodes: { doc: {}, text: {}, paragraph: {} },
})

describe('checkEditorSchema', () => {
  beforeEach(() => {
    logPluginMocks.error.mockClear()
  })

  it('passes a complete schema silently', async () => {
    const { checkEditorSchema, errorMessage } = await freshModules()
    expect(checkEditorSchema(goodSchema)).toBe(true)
    expect(get(errorMessage)).toBeNull()
    expect(logPluginMocks.error).not.toHaveBeenCalled()
  })

  it('fails a schema without image nodes: banner + persisted log', async () => {
    const { checkEditorSchema, errorMessage } = await freshModules()
    expect(checkEditorSchema(imagelessSchema)).toBe(false)
    expect(get(errorMessage)).toContain('image-block|image')
    expect(logPluginMocks.error).toHaveBeenCalledTimes(1)
    expect(logPluginMocks.error.mock.calls[0][0]).toContain('image-block|image')
  })

  it('treats a throwing getSchema as a failure and reports it', async () => {
    const { checkEditorSchema, errorMessage } = await freshModules()
    const boom = () => {
      throw new Error('ctx destroyed')
    }
    expect(checkEditorSchema(boom)).toBe(false)
    expect(get(errorMessage)).toContain('ctx destroyed')
    expect(logPluginMocks.error).toHaveBeenCalledTimes(1)
  })

  it('raises the banner once but logs every failing call', async () => {
    const { checkEditorSchema, errorMessage, clearError } = await freshModules()
    expect(checkEditorSchema(imagelessSchema)).toBe(false)
    clearError() // user dismissed the banner
    expect(checkEditorSchema(imagelessSchema)).toBe(false)
    expect(get(errorMessage)).toBeNull() // remount does not re-raise it
    expect(logPluginMocks.error).toHaveBeenCalledTimes(2) // ...but still logs loudly
  })
})
