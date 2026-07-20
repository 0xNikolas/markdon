import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import { initTheme } from './lib/theme'

initTheme() // stamp data-theme and sync the native titlebar before first paint

const app = mount(App, {
  target: document.getElementById('app')!,
})

export default app
