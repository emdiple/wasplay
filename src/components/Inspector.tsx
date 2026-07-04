import { useEditorStore } from '../store/editorStore'
import { hsl } from '../lib/color'
import { formatTC } from '../lib/format'
import { AudioLevel } from './inspector/AudioLevel'
import { SourceSections } from './inspector/SourceSections'
import type { Clip, Source } from '../types'

/**
 * The persistent, context-aware right Inspector (pro-NLE Properties panel).
 * Shows the selected clip's properties + audio level + its source details; or,
 * when only a bin source is on the stage, just the source details; else an
 * empty state. Desktop/tablet only — mobile keeps the timeline strip + modal.
 */
export function Inspector() {
  const selection = useEditorStore((s) => s.selection)
  const videoClips = useEditorStore((s) => s.videoClips)
  const audioClips = useEditorStore((s) => s.audioClips)
  const sources = useEditorStore((s) => s.sources)
  const selectedSrcId = useEditorStore((s) => s.selectedSrcId)
  const toggleInspector = useEditorStore((s) => s.toggleInspector)

  const byId = new Map(sources.map((s) => [s.id, s]))
  const selectedClips = [...videoClips, ...audioClips].filter((c) => selection.has(c.id))
  const selectedAudio = audioClips.filter((c) => selection.has(c.id))
  const srcIds = new Set(selectedClips.map((c) => c.sourceId))
  // The source to detail: the sole source across the selection, else the bin stage.
  const soleClipSource = srcIds.size === 1 ? byId.get(selectedClips[0].sourceId) : undefined
  const stageSource = byId.get(selectedSrcId ?? '')
  const detailSource = soleClipSource ?? (selectedClips.length === 0 ? stageSource : undefined)

  return (
    <aside className="inspector">
      <div className="panel-head">
        <span>Inspector</span>
        <button className="btn icon inspector-close" onClick={toggleInspector} title="Hide inspector">
          ✕
        </button>
      </div>
      <div className="inspector-body">
        {selectedClips.length > 0 ? (
          <>
            <ClipSection clips={selectedClips} byId={byId} />
            {selectedAudio.length > 0 && (
              <section className="insp-section">
                <div className="panel-label">Audio Level</div>
                <AudioLevel clips={selectedAudio} variant="stack" />
              </section>
            )}
            {detailSource && <SourceSections src={detailSource} />}
          </>
        ) : detailSource ? (
          <SourceSections src={detailSource} />
        ) : (
          <div className="inspector-empty">
            Select a clip on the timeline or a media item to see its properties here.
          </div>
        )}
      </div>
    </aside>
  )
}

function ClipSection({ clips, byId }: { clips: Clip[]; byId: Map<string, Source> }) {
  const srcIds = new Set(clips.map((c) => c.sourceId))
  // Multiple sources selected → a bare summary; nothing meaningful to detail.
  if (srcIds.size > 1) {
    return (
      <div className="panel">
        <div className="panel-label">Selection</div>
        <div className="insp-rows">
          <Row k="Clips" v={String(clips.length)} />
          <Row k="Sources" v={String(srcIds.size)} />
        </div>
      </div>
    )
  }
  // One source (typically a linked A/V pair, which shares start/in/dur) → show
  // the clip's timings from a representative clip.
  const c = clips[0]
  const src = byId.get(c.sourceId)
  return (
    <div className="panel">
      <div className="panel-label">Clip{clips.length > 1 ? ` · ${clips.length} linked` : ''}</div>
      <div className="insp-clip-head">
        {src && <span className="insp-swatch" style={{ background: hsl(src.color, 0.9) }} />}
        <span className="insp-clip-name" title={src?.name}>
          {src?.name ?? 'clip'}
        </span>
      </div>
      <div className="insp-rows">
        <Row k="Start" v={formatTC(c.start)} />
        <Row k="Duration" v={formatTC(c.dur)} />
        <Row k="In" v={formatTC(c.in)} />
        <Row k="Out" v={formatTC(c.in + c.dur)} />
      </div>
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="insp-row">
      <span className="insp-k">{k}</span>
      <span className="insp-v">{v}</span>
    </div>
  )
}
