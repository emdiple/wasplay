import { useState } from 'react'
import { useEditorStore } from '../store/editorStore'
import { useControls } from '../context/ControlsContext'
import { useMediaQuery, COMPACT_QUERY } from '../hooks/useMediaQuery'
import { hsl } from '../lib/color'
import { formatTC } from '../lib/format'
import { formatLufs, formatGain, hasMeasuredLoudness } from '../lib/loudness'
import type { Source } from '../types'

/**
 * The imported media list. A left panel on desktop/tablet; on phones the same
 * element becomes a bottom sheet (CSS repositions it) whose header is the
 * always-visible handle — tapping it slides the list up over the editor.
 */
export function MediaBin() {
  const sources = useEditorStore((s) => s.sources)
  const [sheetOpen, setSheetOpen] = useState(false)
  const closeSheet = () => setSheetOpen(false)

  return (
    <aside className={'bin' + (sheetOpen ? ' sheet-open' : '')}>
      <button className="panel-head bin-handle" onClick={() => setSheetOpen((o) => !o)} aria-expanded={sheetOpen}>
        <span className="sheet-grip" aria-hidden />
        <span>Media Bin</span>
        <span className="count">{sources.length}</span>
        <span className="sheet-chevron" aria-hidden>
          {sheetOpen ? '▾' : '▴'}
        </span>
      </button>
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
          sources.map((src) => <BinItem key={src.id} src={src} onAppend={closeSheet} />)
        )}
      </div>
    </aside>
  )
}

function BinItem({ src, onAppend }: { src: Source; onAppend?: () => void }) {
  const selectedSrcId = useEditorStore((s) => s.selectedSrcId)
  const setStage = useEditorStore((s) => s.setStage)
  const appendSource = useEditorStore((s) => s.appendSource)
  const deleteMedia = useEditorStore((s) => s.deleteMedia)
  const openAnalyzer = useEditorStore((s) => s.openAnalyzer)
  const clearSelection = useEditorStore((s) => s.clearSelection)
  const inspectorOpen = useEditorStore((s) => s.inspectorOpen)
  const toggleInspector = useEditorStore((s) => s.toggleInspector)
  const compact = useMediaQuery(COMPACT_QUERY)
  const clipCount = useEditorStore(
    (s) => s.videoClips.filter((c) => c.sourceId === src.id).length + s.audioClips.filter((c) => c.sourceId === src.id).length,
  )
  const { zoom } = useControls()

  // Desktop: show this source in the right Inspector (stage it, clear any clip
  // selection so the panel resolves to the source, ensure the panel is open).
  // Mobile: open the Analyzer modal instead.
  const analyze = () => {
    if (compact) {
      openAnalyzer(src.id)
      return
    }
    clearSelection()
    setStage(src.id)
    if (!inspectorOpen) toggleInspector()
  }

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
        e.dataTransfer.setData('text/waz-source', src.id)
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
        {src.hasAudio && (
          <div className="bin-loudness" title="Integrated loudness (EBU R128) · click ⌕ to adjust output level">
            <span className={'lufs' + (hasMeasuredLoudness(src.lufs) && src.lufs > -9 ? ' warn' : '')}>
              {src.lufs === undefined ? 'measuring…' : formatLufs(src.lufs)}
            </span>
            {src.gainDb !== 0 && <span className="gain-badge">{formatGain(src.gainDb)}</span>}
          </div>
        )}
      </div>
      <div className="bin-actions">
        <button
          className="bin-btn"
          title="Add to timeline"
          onClick={(e) => {
            e.stopPropagation()
            appendSource(src.id)
            zoom.fitTimeline()
            onAppend?.()
          }}
        >
          ＋
        </button>
        {src.hasAudio && (
          <button
            className="bin-btn"
            title="Inspect & adjust output level"
            onClick={(e) => {
              e.stopPropagation()
              analyze()
            }}
          >
            ⌕
          </button>
        )}
        <button
          className="bin-btn bin-delete"
          title={clipCount ? `Remove media and its ${clipCount} clip(s) from the timeline` : 'Remove media'}
          onClick={(e) => {
            e.stopPropagation() // don't also select the item
            deleteMedia(src.id)
          }}
        >
          ✕
        </button>
      </div>
    </div>
  )
}
