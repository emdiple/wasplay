import { useRef } from 'react'
import { useEditorStore } from '../store/editorStore'
import { useControls } from '../context/ControlsContext'
import { useMediaQuery, COMPACT_QUERY } from '../hooks/useMediaQuery'
import { usePreviewTrack } from '../hooks/usePreviewTrack'
import { hsl } from '../lib/color'
import { formatTC } from '../lib/format'
import { topmostClipAt, trackPriority } from '../lib/timeline'
import { fadeGain } from '../lib/fade'
import { transitionAt } from '../lib/transition'
import { TransportBar } from './TransportBar'
import type { Source } from '../types'

/** Centre panel: the preview stage + the transport bar. Once the timeline has
 * any clips, the stage becomes a "program monitor" following the playhead;
 * otherwise it shows the selected bin source (or the welcome card). */
export function Preview() {
  const selectedSrcId = useEditorStore((s) => s.selectedSrcId)
  const src = useEditorStore((s) => s.sources.find((x) => x.id === s.selectedSrcId) ?? null)
  const hasTimelineContent = useEditorStore((s) => s.videoClips.length > 0 || s.audioClips.length > 0)

  return (
    <div className="preview">
      <div className="stage">
        {hasTimelineContent ? <ProgramMonitor /> : src ? <SourceCard src={src} key={selectedSrcId} /> : <DefaultCard />}
      </div>
      <TransportBar />
    </div>
  )
}

/**
 * Shows whichever clips are under the playhead, driven by real `<video>`/`<audio>`
 * elements rather than a composited render — see usePreviewTrack for the sync
 * strategy. Each track has a "to" (foreground) layer and, only while the playhead
 * sits inside a cross-dissolve, a "from" (background) layer, so dissolves preview
 * live: the picture crossfades via layer opacity and the sound via volume ramps.
 * When a video clip and its audio clip are a genuinely linked A/V pair the video
 * plays its own embedded audio and the separate audio element stays idle (avoids
 * decoding the same file twice).
 */
function ProgramMonitor() {
  const { transport } = useControls()
  const playing = transport.playing
  const playheadTime = useEditorStore((s) => s.playheadTime)
  const videoClips = useEditorStore((s) => s.videoClips)
  const audioClips = useEditorStore((s) => s.audioClips)
  const sources = useEditorStore((s) => s.sources)
  const previewMuted = useEditorStore((s) => s.previewMuted)

  const toVideoRef = useRef<HTMLVideoElement>(null)
  const fromVideoRef = useRef<HTMLVideoElement>(null)
  const toAudioRef = useRef<HTMLAudioElement>(null)
  const fromAudioRef = useRef<HTMLAudioElement>(null)

  const srcOf = (clip: { sourceId: string } | null) =>
    clip ? sources.find((s) => s.id === clip.sourceId) : undefined

  // What the monitor shows: the topmost clip across layers (track priority,
  // then within-track z) — matching what export composites on top. A dissolve
  // is honored only when one of its two clips is that topmost clip; audio
  // preview plays the topmost audible lane (export still mixes every lane).
  const tracks = useEditorStore((s) => s.tracks)
  const pri = trackPriority(tracks)
  const topV = topmostClipAt(videoClips, pri, playheadTime)
  const topA = topmostClipAt(audioClips, pri, playheadTime)
  const laneTr = (clips: typeof videoClips, top: (typeof videoClips)[number] | null) => {
    if (!top) return null
    const tr = transitionAt(clips.filter((c) => c.trackId === top.trackId), playheadTime)
    return tr && (tr.to.id === top.id || tr.from.id === top.id) ? tr : null
  }
  const vTr = laneTr(videoClips, topV)
  const aTr = laneTr(audioClips, topA)
  const toV = vTr ? vTr.to : topV
  const fromV = vTr ? vTr.from : null
  const toA = aTr ? aTr.to : topA
  const fromA = aTr ? aTr.from : null
  const pV = vTr ? vTr.p : 1

  // A video layer plays its own embedded audio only when it's a linked A/V pair
  // with the sounding audio clip on that side; else that side's audio element does.
  const toLinked = !!toV && !!toA && toV.link === toA.link
  const fromLinked = !!fromV && !!fromA && fromV.link === fromA.link

  // Crossfade volume multipliers: incoming rises with p, outgoing falls with 1−p.
  // Outside a dissolve the incoming side just follows its own fade-in/out envelope.
  const toVol = aTr ? aTr.p : toA ? fadeGain(playheadTime - toA.start, toA.dur, toA.fadeIn, toA.fadeOut) : 1
  const fromVol = aTr ? 1 - aTr.p : 1
  const toGain = toA?.gainDb ?? 0
  const fromGain = fromA?.gainDb ?? 0

  const localOf = (clip: { start: number; in: number } | null) => (clip ? playheadTime - clip.start + clip.in : 0)

  // Foreground video (+ its embedded audio when linked).
  usePreviewTrack(toVideoRef, toV, srcOf(toV), playing, localOf(toV), previewMuted || !toLinked, toGain, toVol)
  // Background video during a dissolve (+ its embedded audio when linked).
  usePreviewTrack(fromVideoRef, fromV, srcOf(fromV), playing, localOf(fromV), previewMuted || !fromLinked, fromGain, fromVol)
  // Detached audio for each side (idle when the video element carries the sound).
  usePreviewTrack(toAudioRef, toLinked ? null : toA, toLinked ? undefined : srcOf(toA), playing, localOf(toA), previewMuted, toGain, toVol)
  usePreviewTrack(fromAudioRef, fromLinked ? null : fromA, fromLinked ? undefined : srcOf(fromA), playing, localOf(fromA), previewMuted, fromGain, fromVol)

  // Fade-to-black overlay only applies outside a dissolve (a dissolve replaces the
  // black backdrop with the outgoing clip's picture).
  const videoFade = !vTr && toV ? fadeGain(playheadTime - toV.start, toV.dur, toV.fadeIn, toV.fadeOut) : 1

  return (
    <div className="program-monitor">
      <video
        ref={fromVideoRef}
        className="program-video under"
        playsInline
        style={{ display: fromV ? 'block' : 'none' }}
      />
      <video
        ref={toVideoRef}
        className="program-video"
        playsInline
        style={{ display: toV ? 'block' : 'none', opacity: vTr ? pV : 1 }}
      />
      <audio ref={fromAudioRef} hidden />
      {toV && videoFade < 1 && (
        <div className="program-fade" style={{ opacity: 1 - videoFade }} aria-hidden />
      )}
      {!toV && !fromV && <div className="program-blank" />}
      <audio ref={toAudioRef} hidden />
    </div>
  )
}

function DefaultCard() {
  return (
    <div className="stage-card">
      <div className="stage-swatch" style={{ background: '#1a1c24' }}>
        ◎
      </div>
      <div className="stage-name">Wazplay</div>
      <div className="stage-hint">
        Import multiple audio/video files. Each file gets its own colour — its video and audio share that colour on the
        single-layer timeline below.
      </div>
    </div>
  )
}

function SourceCard({ src }: { src: Source }) {
  const openAnalyzer = useEditorStore((s) => s.openAnalyzer)
  const inspectorOpen = useEditorStore((s) => s.inspectorOpen)
  const toggleInspector = useEditorStore((s) => s.toggleInspector)
  const compact = useMediaQuery(COMPACT_QUERY)
  // Desktop shows this staged source in the Inspector already — just reveal it;
  // mobile opens the Analyzer modal.
  const inspect = () => {
    if (compact) openAnalyzer(src.id)
    else if (!inspectorOpen) toggleInspector()
  }

  const parts: string[] = [src.isVideo ? 'Video' : 'Audio', formatTC(src.duration)]
  if (src.isVideo && src.width) parts.push(`${src.width}×${src.height}`)
  if (src.isVideo && !src.hasAudio) parts.push('silent')
  if (src.info) {
    parts.push(src.info.container || '')
    if (src.info.video_codec) parts.push(src.info.video_codec)
    if (src.info.audio_codec) parts.push(src.info.audio_codec)
  }

  return (
    <div className="stage-card">
      <div className="stage-swatch" style={{ background: hsl(src.color, 0.9) }}>
        {src.isVideo ? '▷' : '♪'}
      </div>
      <div className="stage-name">{src.name}</div>
      <div className="stage-hint">{parts.filter(Boolean).join(' · ')}</div>
      <button className="btn" onClick={inspect}>
        ⌕ Inspect media
      </button>
    </div>
  )
}

