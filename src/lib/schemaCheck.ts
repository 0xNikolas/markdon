import { reportError } from './errors'
import { logError } from './logging'

/**
 * Node types the app depends on at runtime, as groups where ANY member
 * satisfies the group. The `image-block | image` group mirrors exactly the
 * fallback the paste uploader in Editor.svelte uses
 * (`schema.nodes['image-block'] ?? schema.nodes.image`) — that uploader exists
 * because a production-bundle regression once silently dropped Crepe's
 * ImageBlock feature, so dev builds worked while release swallowed pasted
 * images. This check turns that class of dev/release divergence into a loud
 * failure at editor mount.
 */
export const REQUIRED_NODE_GROUPS: readonly (readonly string[])[] = [
  ['doc'],
  ['text'],
  ['paragraph'],
  ['image-block', 'image'],
]

/**
 * Mark types the toolbar/formatting layer depends on. Single-member groups
 * (marks have no fallback aliases): Crepe's builder unconditionally loads
 * preset-commonmark (strong, emphasis, inlineCode, link) and preset-gfm
 * (strike_through), so all five must survive into any healthy bundle.
 */
export const REQUIRED_MARK_GROUPS: readonly (readonly string[])[] = [
  ['strong'],
  ['emphasis'],
  ['inlineCode'],
  ['link'],
  ['strike_through'],
]

/**
 * Commands the app's UI actually drives: the toolbar's core formatting
 * actions plus InsertImage (the image-parity motivation for this whole
 * check). Names are Milkdown's `$command(...)` registrations in
 * preset-commonmark; a future @milkdown major renaming them would turn this
 * into a false alarm at mount, limited to one banner by the once-guard below.
 */
export const REQUIRED_COMMANDS: readonly string[] = [
  'ToggleStrong',
  'ToggleEmphasis',
  'ToggleInlineCode',
  'ToggleLink',
  'InsertImage',
]

/**
 * The groups from `groups` that `names` satisfies NO member of, each
 * formatted for display as `'image-block|image'`. Pure.
 */
export function missingGroups(
  names: readonly string[],
  groups: readonly (readonly string[])[],
): string[] {
  const present = new Set(names)
  return groups.filter((group) => !group.some((n) => present.has(n))).map((group) => group.join('|'))
}

/**
 * The names from `required` that `getCommand` cannot produce. Milkdown's
 * CommandManager.get(name) THROWS (contextNotFound) for an unregistered
 * command — the throw is the detection mechanism, so a lookup that merely
 * returned undefined would pass. Pure given a pure getCommand.
 */
export function missingCommands(
  getCommand: (name: string) => unknown,
  required: readonly string[] = REQUIRED_COMMANDS,
): string[] {
  return required.filter((name) => {
    try {
      getCommand(name)
      return false
    } catch {
      return true
    }
  })
}

// The error banner is raised at most once per app session: split-view toggles
// remount Editor via App.svelte's {#key $doc.loadId} block, and a broken
// bundle failing identically on every remount must not re-raise a banner the
// user already dismissed. The log line still fires on EVERY failing mount.
let bannerShown = false

/** What checkEditorSchema inspects, produced by the caller's thunk. */
export interface EditorIntrospection {
  schema: { nodes: Record<string, unknown>; marks: Record<string, unknown> }
  getCommand: (name: string) => unknown
}

/**
 * Verify the created editor carries every required node group, mark group,
 * and command. `getEditor` is a thunk so a throwing context read (destroyed
 * editor, missing slice) is caught and reported as a failure rather than
 * escaping. On failure: persists a loud log line via logging.ts on every
 * call, and raises the error banner (reportError) on the first failure only.
 * Returns whether everything passed.
 */
export function checkEditorSchema(getEditor: () => EditorIntrospection): boolean {
  let problem: string | null = null
  try {
    const { schema, getCommand } = getEditor()
    const parts: string[] = []
    const nodes = missingGroups(Object.keys(schema.nodes), REQUIRED_NODE_GROUPS)
    if (nodes.length > 0) parts.push(`node types: ${nodes.join(', ')}`)
    const marks = missingGroups(Object.keys(schema.marks), REQUIRED_MARK_GROUPS)
    if (marks.length > 0) parts.push(`mark types: ${marks.join(', ')}`)
    const commands = missingCommands(getCommand)
    if (commands.length > 0) parts.push(`commands: ${commands.join(', ')}`)
    if (parts.length > 0) {
      problem = `Editor schema is missing required ${parts.join('; ')} — editing/image features will be broken in this build`
    }
  } catch (e) {
    problem = `Editor schema could not be inspected: ${String(e)}`
  }
  if (problem === null) return true
  if (bannerShown) {
    logError(problem)
  } else {
    bannerShown = true
    reportError(problem) // banner + the same persisted log line
  }
  return false
}
