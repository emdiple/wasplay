import { useEditorStore } from '../store/editorStore'
import { useControls } from '../context/ControlsContext'
import { hsl } from '../lib/color'
import { formatTC } from '../lib/format'
import type { Source } from '../types'

/** Left panel: the imported media list. Double-click a row to append it. */
export function MediaBin() {
  const sources = useEditorStore((s) => s.sources)

  return (
    <aside className="bin">
      <div className="panel-head">
        <span>Media Bin</span>
        <span className="count">{sources.length}</span>
      </div>
      <div className="bin-list">
        {sources.length === 0 ? (
          <div className="bin-empty">
            No media yet.
            <br />
            Import files, then double-click to
            <br />
            add them to the timeline.
          </div>
        ) : (
          sources.map((src) => <BinItem key={src.id} src={src} />)
        )}
      </div>
    </aside>
  )
}

function BinItem({ src }: { src: Source }) {
  const selectedSrcId = useEditorStore((s) => s.selectedSrcId)
  const setStage = useEditorStore((s) => s.setStage)
  const appendSource = useEditorStore((s) => s.appendSource)
  const { zoom } = useControls()

  const kind = src.isVideo ? (src.hasAudio ? 'video' : 'video · silent') : 'audio'
  const dims = src.isVideo && src.width ? ` · ${src.width}×${src.height}` : ''

  return (
    <div
      className={'bin-item' + (src.id === selectedSrcId ? ' sel' : '')}
      draggable
      onClick={() => setStage(src.id)}
      onDoubleClick={() => {
        appendSource(src.id)
        zoom.fitTimeline()
      }}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/fox-source', src.id)
        e.dataTransfer.effectAllowed = 'copy'
      }}
    >
      <div className="swatch" style={{ background: hsl(src.color, 0.95) }} />
      <div className="bin-meta">
        <div className="bin-name">{src.name}</div>
        <div className="bin-sub">
          <span className="kind">{kind}</span> · {formatTC(src.duration)}
          {dims}
        </div>
      </div>
    </div>
  )
}
