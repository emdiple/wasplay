import { useRef } from 'react'
import { useEditorStore } from '../store/editorStore'
import { useControls } from '../context/ControlsContext'
import { Logo } from './Logo'

interface TopBarProps {
  importFiles: (files: FileList) => void
}

/** App bar: brand, import, undo/redo, theme, export, clear, and the status line.
 *  Editing tools live in the left ToolRail; transport lives under the preview. */
export function TopBar({ importFiles }: TopBarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { transport } = useControls()

  const status = useEditorStore((s) => s.status)
  const clearTimeline = useEditorStore((s) => s.clearTimeline)
  const setExportOpen = useEditorStore((s) => s.setExportOpen)
  const theme = useEditorStore((s) => s.theme)
  const toggleTheme = useEditorStore((s) => s.toggleTheme)
  const undo = useEditorStore((s) => s.undo)
  const redo = useEditorStore((s) => s.redo)
  const canUndo = useEditorStore((s) => s.past.length > 0)
  const canRedo = useEditorStore((s) => s.future.length > 0)
  const inspectorOpen = useEditorStore((s) => s.inspectorOpen)
  const toggleInspector = useEditorStore((s) => s.toggleInspector)

  const onClear = () => {
    transport.pause()
    clearTimeline()
  }

  return (
    <header className="topbar">
      <Logo />

      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*,video/*"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) importFiles(e.target.files)
          e.target.value = ''
        }}
      />

      <div className="toolbar-group">
        <button className="btn primary" onClick={() => fileInputRef.current?.click()}>
          ＋ <span className="btn-label">Import media</span>
        </button>
      </div>

      <div className="sep" />

      <div className="toolbar-group">
        <button className="btn icon" title="Undo (⌘Z)" onClick={undo} disabled={!canUndo}>
          ↶ <span className="btn-label">Undo</span>
        </button>
        <button className="btn icon" title="Redo (⇧⌘Z)" onClick={redo} disabled={!canRedo}>
          ↷ <span className="btn-label">Redo</span>
        </button>
      </div>

      <span className="status">{status}</span>

      <div className="spacer" />

      <div className="toolbar-group">
        <button
          className="btn icon"
          title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          onClick={toggleTheme}
        >
          {theme === 'dark' ? '☀' : '☾'}
        </button>
        <button
          className={'btn icon inspector-toggle' + (inspectorOpen ? ' active' : '')}
          title={inspectorOpen ? 'Hide inspector' : 'Show inspector'}
          onClick={toggleInspector}
        >
          ▤
        </button>
      </div>

      <div className="sep" />

      <button className="btn primary" title="Export EDL or render media" onClick={() => setExportOpen(true)}>
        ⬆ <span className="btn-label">Export</span>
      </button>
      <button className="btn icon" title="Clear timeline" onClick={onClear}>
        Clear
      </button>
    </header>
  )
}
