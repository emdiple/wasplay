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

      // Undo/redo: Cmd/Ctrl+Z, and Cmd+Shift+Z or Ctrl+Y to redo.
      if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        if (e.shiftKey) store.redo()
        else store.undo()
        return
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault()
        store.redo()
        return
      }

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
