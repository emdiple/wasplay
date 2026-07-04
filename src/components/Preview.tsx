import { useRef } from 'react'
import { useEditorStore } from '../store/editorStore'
import { useControls } from '../context/ControlsContext'
import { useMediaQuery, COMPACT_QUERY } from '../hooks/useMediaQuery'
import { usePreviewTrack } from '../hooks/usePreviewTrack'
import { hsl } from '../lib/color'
import { formatTC } from '../lib/format'
import { clipAtTime } from '../lib/timeline'
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
 * Shows whichever video clip is under the playhead (with sound from whichever
 * audio clip is under the playhead), driven by real `<video>`/`<audio>`
 * elements rather than a composited render — see usePreviewTrack for the
 * sync strategy. When the video and audio clips under the playhead are a
 * genuinely linked A/V pair, the video's own audio plays and the separate
 * audio element stays silent (avoids double-decoding the same file).
 */
function ProgramMonitor() {
  const { transport } = useControls()
  const playheadTime = useEditorStore((s) => s.playheadTime)
  const videoClips = useEditorStore((s) => s.videoClips)
  const audioClips = useEditorStore((s) => s.audioClips)
  const sources = useEditorStore((s) => s.sources)
  const previewMuted = useEditorStore((s) => s.previewMuted)

  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)

  const activeVideoClip = clipAtTime(videoClips, playheadTime)
  const activeAudioClip = clipAtTime(audioClips, playheadTime)
  const videoSource = activeVideoClip ? sources.find((s) => s.id === activeVideoClip.sourceId) : undefined
  const audioSource = activeAudioClip ? sources.find((s) => s.id === activeAudioClip.sourceId) : undefined

  // When the video and audio clips under the playhead are a genuinely linked
  // A/V pair, the video plays its own embedded audio and the separate audio
  // element stays idle. Once detached, the audio clip drives the audio element
  // and the video element is muted — so the file is never decoded twice.
  const linked = !!activeVideoClip && !!activeAudioClip && activeVideoClip.link === activeAudioClip.link

  const videoLocalTime = activeVideoClip ? playheadTime - activeVideoClip.start + activeVideoClip.in : 0
  const audioLocalTime = activeAudioClip ? playheadTime - activeAudioClip.start + activeAudioClip.in : 0

  // Whichever element is actually sounding uses the audio clip's per-clip gain:
  // when linked, the video plays the pair's embedded audio, so it carries the
  // level; when detached, the audio element does.
  const gainDb = activeAudioClip?.gainDb ?? 0

  usePreviewTrack(videoRef, activeVideoClip, videoSource, transport.playing, videoLocalTime, previewMuted || !linked, gainDb)
  usePreviewTrack(
    audioRef,
    linked ? null : activeAudioClip,
    linked ? undefined : audioSource,
    transport.playing,
    audioLocalTime,
    previewMuted,
    gainDb,
  )

  return (
    <div className="program-monitor">
      <video ref={videoRef} className="program-video" playsInline style={{ display: activeVideoClip ? 'block' : 'none' }} />
      {!activeVideoClip && <div className="program-blank" />}
      <audio ref={audioRef} hidden />
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

