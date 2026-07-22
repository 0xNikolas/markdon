import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import { initTheme } from './lib/theme'
import { initSettings } from './lib/settings'
import { installGlobalErrorSink } from './lib/logging'

initTheme() // stamp data-theme and sync the native titlebar before first paint
initSettings() // load preferences, stamp --editor-* vars; seeds theme from the legacy key on first run
installGlobalErrorSink() // forward console.warn/error + uncaught errors/rejections to markdon.log

const app = mount(App, {
  target: document.getElementById('app')!,
})

export default app
