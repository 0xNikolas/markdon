import { describe, it, expect, beforeEach, vi } from 'vitest'
import { get } from 'svelte/store'
import { logPluginMocks } from './test-support/tauriMocks'
import {
  missingGroups,
  missingCommands,
  REQUIRED_NODE_GROUPS,
  REQUIRED_MARK_GROUPS,
  REQUIRED_COMMANDS,
  type EditorIntrospection,
} from './schemaCheck'

const FULL_NODE_SET = ['doc', 'text', 'paragraph', 'image-block', 'heading', 'blockquote']
const FULL_MARK_SET = ['strong', 'emphasis', 'inlineCode', 'link', 'strike_through']

/** getCommand mimicking Milkdown's CommandManager.get: THROWS for absent
 * names (contextNotFound), returns a value otherwise. */
const commandTable = (names: readonly string[]) => {
  const table = new Set(names)
  return (name: string): unknown => {
    if (!table.has(name)) throw new Error(`Context "${name}" not found`)
    return () => true
  }
}

describe('missingGroups', () => {
  it('returns [] for a node set containing every required node', () => {
    expect(missingGroups(FULL_NODE_SET, REQUIRED_NODE_GROUPS)).toEqual([])
  })

  it("accepts 'image' alone for the image group (uploader fallback parity)", () => {
    expect(missingGroups(['doc', 'text', 'paragraph', 'image'], REQUIRED_NODE_GROUPS)).toEqual([])
  })

  it('reports a missing image group with both accepted names', () => {
    expect(missingGroups(['doc', 'text', 'paragraph'], REQUIRED_NODE_GROUPS)).toEqual([
      'image-block|image',
    ])
  })

  it('reports every unsatisfied group, in declaration order', () => {
    expect(missingGroups([], REQUIRED_NODE_GROUPS)).toEqual(
      REQUIRED_NODE_GROUPS.map((g) => g.join('|')),
    )
  })

  it('returns [] for the full mark set against the mark groups', () => {
    expect(missingGroups(FULL_MARK_SET, REQUIRED_MARK_GROUPS)).toEqual([])
  })

  it('honors a custom groups parameter', () => {
    expect(missingGroups(['a'], [['a'], ['b', 'c']])).toEqual(['b|c'])
  })
})

describe('missingCommands', () => {
  it('returns [] when every required command resolves', () => {
    expect(missingCommands(commandTable(REQUIRED_COMMANDS))).toEqual([])
  })

  it('collects exactly the names whose lookup throws', () => {
    const partial = commandTable(['ToggleStrong', 'ToggleLink'])
    expect(missingCommands(partial, ['ToggleStrong', 'InsertImage', 'ToggleLink'])).toEqual([
      'InsertImage',
    ])
  })

  it('relies on the throw, not a falsy return — the fixture must actually throw', () => {
    // If a future Milkdown returned undefined instead of throwing for a
    // missing command, this detection would silently pass; keep the
    // mechanism honest by asserting the fixture's throwing behavior.
    expect(() => commandTable([])('InsertImage')).toThrow('not found')
    expect(missingCommands(commandTable([]), ['InsertImage'])).toEqual(['InsertImage'])
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

const editorWith = (
  nodes: readonly string[],
  marks: readonly string[] = FULL_MARK_SET,
  commands: readonly string[] = REQUIRED_COMMANDS,
): (() => EditorIntrospection) => {
  return () => ({
    schema: {
      nodes: Object.fromEntries(nodes.map((n) => [n, {}])),
      marks: Object.fromEntries(marks.map((m) => [m, {}])),
    },
    getCommand: commandTable(commands),
  })
}

const goodEditor = editorWith(FULL_NODE_SET)

const imagelessEditor = editorWith(['doc', 'text', 'paragraph'])

describe('checkEditorSchema', () => {
  beforeEach(() => {
    logPluginMocks.error.mockClear()
  })

  it('passes a complete schema + command set silently', async () => {
    const { checkEditorSchema, errorMessage } = await freshModules()
    expect(checkEditorSchema(goodEditor)).toBe(true)
    expect(get(errorMessage)).toBeNull()
    expect(logPluginMocks.error).not.toHaveBeenCalled()
  })

  it('fails a schema without image nodes: banner + persisted log', async () => {
    const { checkEditorSchema, errorMessage } = await freshModules()
    expect(checkEditorSchema(imagelessEditor)).toBe(false)
    expect(get(errorMessage)).toContain('image-block|image')
    expect(logPluginMocks.error).toHaveBeenCalledTimes(1)
    expect(logPluginMocks.error.mock.calls[0][0]).toContain('image-block|image')
  })

  it('reports a missing mark type (strike_through) as a mark group', async () => {
    const { checkEditorSchema, errorMessage } = await freshModules()
    const gfmless = editorWith(FULL_NODE_SET, ['strong', 'emphasis', 'inlineCode', 'link'])
    expect(checkEditorSchema(gfmless)).toBe(false)
    expect(get(errorMessage)).toContain('mark types: strike_through')
  })

  it('reports a command whose lookup throws as missing', async () => {
    const { checkEditorSchema, errorMessage } = await freshModules()
    const strongless = editorWith(
      FULL_NODE_SET,
      FULL_MARK_SET,
      REQUIRED_COMMANDS.filter((c) => c !== 'ToggleStrong'),
    )
    expect(checkEditorSchema(strongless)).toBe(false)
    expect(get(errorMessage)).toContain('commands: ToggleStrong')
  })

  it('enumerates every failing category in one problem string', async () => {
    const { checkEditorSchema, errorMessage } = await freshModules()
    expect(checkEditorSchema(editorWith(['doc', 'text', 'paragraph'], [], []))).toBe(false)
    const msg = get(errorMessage)
    expect(msg).toContain('node types: image-block|image')
    expect(msg).toContain('mark types: strong')
    expect(msg).toContain('commands: ToggleStrong')
  })

  it('treats a throwing thunk as a failure and reports it', async () => {
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
    expect(checkEditorSchema(imagelessEditor)).toBe(false)
    clearError() // user dismissed the banner
    expect(checkEditorSchema(imagelessEditor)).toBe(false)
    expect(get(errorMessage)).toBeNull() // remount does not re-raise it
    expect(logPluginMocks.error).toHaveBeenCalledTimes(2) // ...but still logs loudly
  })
})
