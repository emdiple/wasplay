import { useEffect } from 'react'
import { useEditorStore } from '../store/editorStore'
import type { TransportControls } from './useTransport'

/** Global editor keyboard shortcuts (ignored while the app is busy or typing). */
export function useKeyboardShortcuts(transport: TransportControls): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const store = useEditorStore.getState()
      if (store.busy) return
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return

      switch (e.key) {
        case 'v':
        case 'V':
          store.setTool('select')
          break
        case 'c':
        case 'C':
          store.setTool('cut')
          break
        case 's':
        case 'S':
          e.preventDefault()
          store.splitAtPlayhead()
          break
        case 'Delete':
        case 'Backspace':
          e.preventDefault()
          store.deleteSelected()
          break
        case ' ':
          e.preventDefault()
          transport.toggle()
          break
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [transport])
}
