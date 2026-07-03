import { useRef } from 'react'
import { useEditorStore } from '../store/editorStore'
import { useControls } from '../context/ControlsContext'
import { Logo } from './Logo'

interface TopBarProps {
  importFiles: (files: FileList) => void
}

/** Top toolbar: import, tools, transport, zoom, clear, and the status line. */
export function TopBar({ importFiles }: TopBarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { zoom, transport } = useControls()

  const tool = useEditorStore((s) => s.tool)
  const pxPerSec = useEditorStore((s) => s.pxPerSec)
  const status = useEditorStore((s) => s.status)
  const setTool = useEditorStore((s) => s.setTool)
  const deleteSelected = useEditorStore((s) => s.deleteSelected)
  const clearTimeline = useEditorStore((s) => s.clearTimeline)
  const setExportOpen = useEditorStore((s) => s.setExportOpen)
  const theme = useEditorStore((s) => s.theme)
  const toggleTheme = useEditorStore((s) => s.toggleTheme)
  const undo = useEditorStore((s) => s.undo)
  const redo = useEditorStore((s) => s.redo)
  const canUndo = useEditorStore((s) => s.past.length > 0)
  const canRedo = useEditorStore((s) => s.future.length > 0)

  const zoomLabel = (pxPerSec < 10 ? pxPerSec.toFixed(1) : Math.round(pxPerSec)) + ' px/s'

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
          ＋ Import media
        </button>
      </div>

      <div className="sep" />

      <div className="toolbar-group">
        <button className="btn icon" title="Undo (⌘Z)" onClick={undo} disabled={!canUndo}>
          ↶ Undo
        </button>
        <button className="btn icon" title="Redo (⇧⌘Z)" onClick={redo} disabled={!canRedo}>
          ↷ Redo
        </button>
      </div>

      <div className="sep" />

      <div className="toolbar-group">
        <button
          className={'btn icon' + (tool === 'select' ? ' active' : '')}
          title="Select / move (V)"
          onClick={() => setTool('select')}
        >
          ▲ Select
        </button>
        <button
          className={'btn icon' + (tool === 'cut' ? ' active' : '')}
          title="Cut / razor (C)"
          onClick={() => setTool('cut')}
        >
          ✂ Cut
        </button>
        <button className="btn icon" title="Delete selected (⌫)" onClick={deleteSelected}>
          🗑 Delete
        </button>
      </div>

      <div className="sep" />

      <div className="toolbar-group">
        <button className="btn icon" title="Play / pause (Space)" onClick={transport.toggle}>
          {transport.playing ? '❚❚' : '▶'}
        </button>
      </div>

      <div className="spacer" />

      <div className="toolbar-group">
        <button className="btn icon" title="Zoom out" onClick={zoom.zoomOut}>
          －
        </button>
        <span className="zoom-label">{zoomLabel}</span>
        <button className="btn icon" title="Zoom in" onClick={zoom.zoomIn}>
          ＋
        </button>
      </div>

      <div className="sep" />
      <button
        className="btn icon"
        title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        onClick={toggleTheme}
      >
        {theme === 'dark' ? '☀' : '☾'}
      </button>
      <button className="btn primary" title="Export EDL or render media" onClick={() => setExportOpen(true)}>
        ⬆ Export
      </button>
      <button className="btn icon" title="Clear timeline" onClick={onClear}>
        Clear
      </button>
      <span className="status">{status}</span>
    </header>
  )
}
