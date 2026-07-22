import { info, warn, error } from '@tauri-apps/plugin-log'

/**
 * Release error sink: the ONLY module that imports @tauri-apps/plugin-log.
 * Components go through logInfo/logWarn/logError (or transitively through
 * errors.ts's reportError/reportNotice), so tests stub one module and the
 * plugin's `plugin:log|log` invokes never hit the shared invoke spy.
 *
 * Every persist call is fire-and-forget and swallows failure — logging must
 * never throw or leave an unhandled rejection, including under vitest or a
 * plain browser where the Tauri IPC internals are absent.
 *
 * The Rust side deliberately has no Webview log target and this module never
 * calls attachConsole: console output is forwarded INTO the plugin here, so
 * plugin output echoed back to the console would loop.
 */

/**
 * Console methods captured at module load, BEFORE installGlobalErrorSink wraps
 * the live ones — the log functions echo through these, so a wrapped
 * console.error forwarding into logError cannot recurse.
 */
const orig = {
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
}

/** Render an unknown thrown value: Error message + stack when present, else String(). */
export function formatUnknown(e: unknown): string {
  if (e instanceof Error) return e.stack ? `${e.message}\n${e.stack}` : e.message
  return String(e)
}

function persist(
  sink: (msg: string) => Promise<void>,
  echo: (msg: string) => void,
  msg: string,
  err?: unknown,
): void {
  const line = err === undefined ? msg : `${msg}: ${formatUnknown(err)}`
  echo(line)
  try {
    void sink(line).catch(() => {})
  } catch {
    // @tauri-apps/api throws synchronously when __TAURI_INTERNALS__ is missing
  }
}

export function logInfo(msg: string): void {
  persist(info, orig.info, msg)
}

export function logWarn(msg: string, err?: unknown): void {
  persist(warn, orig.warn, msg, err)
}

export function logError(msg: string, err?: unknown): void {
  persist(error, orig.error, msg, err)
}

/** The subset of Window the sink needs — injectable so tests stay node-env. */
type SinkTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>

let installed = false

/**
 * Wrap console.warn/error to also persist through the log plugin, and (when a
 * window-like target exists) log uncaught errors and unhandled promise
 * rejections — the latter is what finally makes every bare `void somePromise()`
 * failure visible in a release build. Idempotent; returns an uninstall
 * function that restores the console and removes the listeners (for tests).
 */
export function installGlobalErrorSink(
  target: SinkTarget | undefined = typeof window === 'undefined' ? undefined : window,
): () => void {
  if (installed) return () => {}
  installed = true

  const prevWarn = console.warn
  const prevError = console.error
  console.warn = (...args: unknown[]) => logWarn(args.map(formatUnknown).join(' '))
  console.error = (...args: unknown[]) => logError(args.map(formatUnknown).join(' '))

  const onError = (ev: Event): void => {
    const e = ev as ErrorEvent
    logError(`Uncaught error: ${e.message} (${e.filename}:${e.lineno}:${e.colno})`, e.error)
  }
  const onRejection = (ev: Event): void => {
    logError('Unhandled promise rejection', (ev as PromiseRejectionEvent).reason)
  }
  target?.addEventListener('error', onError)
  target?.addEventListener('unhandledrejection', onRejection)

  return () => {
    console.warn = prevWarn
    console.error = prevError
    target?.removeEventListener('error', onError)
    target?.removeEventListener('unhandledrejection', onRejection)
    installed = false
  }
}
