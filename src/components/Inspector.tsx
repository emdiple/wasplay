import { useEditorStore } from '../store/editorStore'
import { hsl } from '../lib/color'
import { formatTC } from '../lib/format'
import { AudioLevel } from './inspector/AudioLevel'
import { ClipFades } from './inspector/ClipFades'
import { ClipDissolve, useCanDissolve } from './inspector/ClipDissolve'
import { InspGroup } from './inspector/InspGroup'
import { SourceSections } from './inspector/SourceSections'
import type { Clip, Source } from '../types'

/**
 * The persistent, context-aware right Inspector — a pro-NLE properties panel.
 * A selected clip gets a header (swatch · name · type/format chips) followed by
 * collapsible property groups (Info, Fades, Transition, Audio) and its source
 * detail; a bin source alone shows just the source detail; else an empty state.
 * Desktop/tablet only — mobile keeps the timeline strip + analyzer modal.
 */
export function Inspector() {
  const selection = useEditorStore((s) => s.selection)
  const videoClips = useEditorStore((s) => s.videoClips)
  const audioClips = useEditorStore((s) => s.audioClips)
  const sources = useEditorStore((s) => s.sources)
  const selectedSrcId = useEditorStore((s) => s.selectedSrcId)
  const toggleInspector = useEditorStore((s) => s.toggleInspector)

  const byId = new Map(sources.map((s) => [s.id, s]))
  const selectedVideo = videoClips.filter((c) => selection.has(c.id))
  const selectedAudio = audioClips.filter((c) => selection.has(c.id))
  const selectedClips = [...selectedVideo, ...selectedAudio]
  const srcIds = new Set(selectedClips.map((c) => c.sourceId))
  const singleGroup = new Set(selectedClips.map((c) => c.link)).size === 1
  const repClip = selectedClips[0]
  const canDissolve = useCanDissolve(singleGroup ? repClip : undefined)

  // The source to detail: the sole source across the selection, else the bin stage.
  const soleClipSource = srcIds.size === 1 ? byId.get(repClip.sourceId) : undefined
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
            <ClipHeader clips={selectedClips} byId={byId} hasVideo={selectedVideo.length > 0} hasAudio={selectedAudio.length > 0} />
            {srcIds.size === 1 && (
              <InspGroup title="Info">
                <ClipInfo clip={repClip} />
              </InspGroup>
            )}
            <InspGroup title="Fades">
              <ClipFades clips={selectedClips} variant="stack" />
            </InspGroup>
            {singleGroup && canDissolve && (
              <InspGroup title="Transition" hint="Dissolve">
                <ClipDissolve clip={repClip} />
              </InspGroup>
            )}
            {selectedAudio.length > 0 && (
              <InspGroup title="Audio">
                <AudioLevel clips={selectedAudio} variant="stack" />
              </InspGroup>
            )}
            {detailSource && <SourceSections src={detailSource} context="clip" />}
          </>
        ) : detailSource ? (
          <SourceSections src={detailSource} context="source" />
        ) : (
          <div className="inspector-empty">
            <span className="inspector-empty-icon" aria-hidden>
              ⌗
            </span>
            <p>Select a clip on the timeline or a media item to see its properties here.</p>
          </div>
        )}
      </div>
    </aside>
  )
}

/** The identity block at the top of a clip selection: swatch, name, type/format chips. */
function ClipHeader({
  clips,
  byId,
  hasVideo,
  hasAudio,
}: {
  clips: Clip[]
  byId: Map<string, Source>
  hasVideo: boolean
  hasAudio: boolean
}) {
  const srcIds = new Set(clips.map((c) => c.sourceId))
  const links = new Set(clips.map((c) => c.link))
  const multi = srcIds.size > 1
  const src = multi ? undefined : byId.get(clips[0].sourceId)
  const kind = hasVideo && hasAudio ? 'A / V' : hasVideo ? 'Video' : 'Audio'

  const chips: string[] = multi
    ? [`${clips.length} clips`, `${srcIds.size} sources`]
    : [kind, ...(src?.isVideo && src.width ? [`${src.width}×${src.height}`] : []), formatTC(clips[0].dur)]

  const title = multi ? 'Multiple clips' : (src?.name ?? 'Clip')
  const swatch = src ? hsl(src.color, 0.9) : '#5b6070'

  return (
    <div className="insp-clip-header">
      <span className="insp-swatch" style={{ background: swatch }} />
      <div className="insp-clip-meta">
        <span className="insp-clip-name" title={title}>
          {title}
          {!multi && links.size === 1 && clips.length > 1 && (
            <span className="insp-linked" title="Linked A/V">
              🔗
            </span>
          )}
        </span>
        <div className="insp-chips">
          {chips.map((c) => (
            <span className="insp-chip" key={c}>
              {c}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Read-only timing read-out for a single clip (or a linked pair sharing timings). */
function ClipInfo({ clip }: { clip: Clip }) {
  return (
    <div className="insp-rows">
      <Row k="Start" v={formatTC(clip.start)} />
      <Row k="Duration" v={formatTC(clip.dur)} />
      <Row k="In" v={formatTC(clip.in)} />
      <Row k="Out" v={formatTC(clip.in + clip.dur)} />
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
