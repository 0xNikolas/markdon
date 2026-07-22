import type { WorkspaceDir, WorkspaceFile } from '../workspace'

/**
 * Shared WorkspaceDir fixture builders for the file-ops test suites
 * (fileTree / fileOpsState / fileMutations), plus the sample tree they all
 * exercise.
 */

export const file = (name: string, path: string): WorkspaceFile => ({ name, path })

export const dir = (
  name: string,
  path: string,
  dirs: WorkspaceDir[] = [],
  files: WorkspaceFile[] = [],
): WorkspaceDir => ({
  name,
  path,
  dirs,
  files,
  truncated: false,
})

// /ws
//   docs/           (expanded)
//     note.md
//   img/            (collapsed)
//     logo.svg
//   readme.md
export const tree: WorkspaceDir = dir(
  'ws',
  '/ws',
  [
    dir('docs', '/ws/docs', [], [file('note.md', '/ws/docs/note.md')]),
    dir('img', '/ws/img', [], [file('logo.svg', '/ws/img/logo.svg')]),
  ],
  [file('readme.md', '/ws/readme.md')],
)
