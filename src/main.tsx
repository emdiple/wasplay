import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { useEditorStore } from './store/editorStore'
import './styles/global.css'

// Keep <html data-theme> in sync with the store. Applied here (not in a React
// effect) so it updates synchronously inside the store's `set()` — before any
// component re-renders or canvas-redraw effect reads its theme colours, which
// avoids a child-effect-runs-before-parent-effect ordering bug. Also set once
// up front to avoid a theme flash on first paint.
const applyTheme = (theme: string) => {
  document.documentElement.dataset.theme = theme
}
applyTheme(useEditorStore.getState().theme)
useEditorStore.subscribe((state) => applyTheme(state.theme))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
