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
 * The groups from `groups` that `nodeNames` satisfies NO member of, each
 * formatted for display as `'image-block|image'`. Pure.
 */
export function missingNodeGroups(
  nodeNames: readonly string[],
  groups: readonly (readonly string[])[] = REQUIRED_NODE_GROUPS,
): string[] {
  const names = new Set(nodeNames)
  return groups.filter((group) => !group.some((n) => names.has(n))).map((group) => group.join('|'))
}

// The error banner is raised at most once per app session: split-view toggles
// remount Editor via App.svelte's {#key $doc.loadId} block, and a broken
// bundle failing identically on every remount must not re-raise a banner the
// user already dismissed. The log line still fires on EVERY failing mount.
let bannerShown = false

/**
 * Verify the created editor's ProseMirror schema contains every required node
 * group. `getSchema` is a thunk so a throwing context read (destroyed editor,
 * missing slice) is caught and reported as a failure rather than escaping.
 * On failure: persists a loud log line via logging.ts on every call, and
 * raises the error banner (reportError) on the first failure only. Returns
 * whether the schema passed.
 */
export function checkEditorSchema(getSchema: () => { nodes: Record<string, unknown> }): boolean {
  let problem: string | null = null
  try {
    const missing = missingNodeGroups(Object.keys(getSchema().nodes))
    if (missing.length > 0) {
      problem = `Editor schema is missing required node types: ${missing.join(', ')} — image paste/rendering will be broken in this build`
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
