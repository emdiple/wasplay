import { useEditorStore } from '../store/editorStore'

/**
 * Left tool rail (pro-NLE style): the editing tools that were in the top bar.
 * Select/Cut set the active `tool`; Split and Delete are one-shot actions. On
 * mobile CSS reflows this into a horizontal strip.
 */
export function ToolRail() {
  const tool = useEditorStore((s) => s.tool)
  const setTool = useEditorStore((s) => s.setTool)
  const splitAtPlayhead = useEditorStore((s) => s.splitAtPlayhead)
  const deleteSelected = useEditorStore((s) => s.deleteSelected)
  const hasSelection = useEditorStore((s) => s.selection.size > 0)

  return (
    <nav className="tool-rail" aria-label="Editing tools">
      <button
        className={'btn icon' + (tool === 'select' ? ' active' : '')}
        title="Select / move (V)"
        onClick={() => setTool('select')}
      >
        ▲
      </button>
      <button
        className={'btn icon' + (tool === 'cut' ? ' active' : '')}
        title="Cut / razor (C)"
        onClick={() => setTool('cut')}
      >
        ✂
      </button>
      <div className="rail-sep" />
      <button className="btn icon" title="Split at playhead (S)" onClick={splitAtPlayhead}>
        ⑂
      </button>
      <button className="btn icon" title="Delete selected (⌫)" onClick={deleteSelected} disabled={!hasSelection}>
        🗑
      </button>
    </nav>
  )
}
