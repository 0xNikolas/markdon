# markdon

## CLI (`md`)

`md` is a terminal launcher that opens a markdown file or a folder in the
Markdon app.

```sh
md notes.md          # open a file
md ./project         # open a folder as a workspace
md a.md b.md ./docs  # open several files plus one workspace folder
md --help            # usage
```

Each launch starts a **new app instance** (a separate process). A file is passed
to the app as a positional argument; a folder is passed as `--workspace <dir>`.
The app's Rust side (`src-tauri/src/launch.rs`) parses those args and adopts them
on startup — the same tested hand-off used by "open in new instance", so the CLI
adds no new Rust code.

> A true *new window inside the already-running instance* (no second process)
> would instead require `tauri-plugin-single-instance` to forward the second
> launch's argv over IPC to the primary instance, which would then spawn a
> `doc-*` window. That is deliberately out of scope; `md` stays a thin argv shim.

### Multiple paths

Any number of files may be given (each opens as a positional). At most **one**
folder is allowed per launch (Rust's parser takes "last `--workspace` wins", so
silently dropping extra folders would surprise) — passing two or more folders is
an error; run `md` once per folder.

### Install

```sh
bun run install:cli
```

This symlinks `scripts/md` into `~/.local/bin` (no sudo). Make sure that
directory is on your `PATH`:

```sh
export PATH="$HOME/.local/bin:$PATH"   # add to ~/.zshrc or ~/.bashrc
```

To install system-wide instead (may need sudo), symlink into `/usr/local/bin`:

```sh
ln -sf "$PWD/scripts/md" /usr/local/bin/md
```

### App binary discovery

`md` looks for the installed macOS binary in this order:

1. `$MARKDON_BIN` (if set — an explicit override)
2. `/Applications/Markdon.app/Contents/MacOS/app`
3. `~/Applications/Markdon.app/Contents/MacOS/app`

If none exist, `md` exits non-zero with the paths it tried. Set `MARKDON_BIN` to
point at a dev build or a non-standard install:

```sh
MARKDON_BIN="$PWD/src-tauri/target/debug/app" md notes.md
```

**Platform scope:** binary discovery is macOS-first (the primary target).
Linux (`/usr/bin/markdon`, `~/.local/bin`, AppImage) and Windows
(`%LOCALAPPDATA%\Markdon\app.exe`) locations are **not** probed yet — on those
platforms use `MARKDON_BIN`. (TODO: add native lookups.)
