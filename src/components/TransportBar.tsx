import { useEditorStore } from '../store/editorStore'
import { useControls } from '../context/ControlsContext'
import { formatTC } from '../lib/format'
import { clipAtTime, domainSeconds } from '../lib/timeline'

/**
 * Transport bar under the preview (pro-NLE style): frame-accurate transport,
 * the master timecode, and the preview mute. Playback/seek come from the shared
 * transport controls; the timecode + total read the store directly.
 */
export function TransportBar() {
  const { transport } = useControls()
  const playheadTime = useEditorStore((s) => s.playheadTime)
  const total = useEditorStore((s) => domainSeconds(s.videoClips, s.audioClips))
  const previewMuted = useEditorStore((s) => s.previewMuted)
  const togglePreviewMuted = useEditorStore((s) => s.togglePreviewMuted)
  // Audio clips only exist for sources with audio, so one under the playhead
  // means there's something to (un)mute.
  const hasAudio = useEditorStore((s) => !!clipAtTime(s.audioClips, s.playheadTime))

  return (
    <div className="transport-bar">
      <div className="toolbar-group">
        <button className="btn icon" title="Go to start (Home)" onClick={transport.goToStart}>
          ⏮
        </button>
        <button className="btn icon" title="Previous frame (←)" onClick={() => transport.stepFrame(-1)}>
          ◂❙
        </button>
        <button className="btn icon transport-play" title="Play / pause (Space)" onClick={transport.toggle}>
          {transport.playing ? '❚❚' : '▶'}
        </button>
        <button className="btn icon" title="Next frame (→)" onClick={() => transport.stepFrame(1)}>
          ❙▸
        </button>
        <button className="btn icon" title="Go to end (End)" onClick={transport.goToEnd}>
          ⏭
        </button>
      </div>

      <div className="transport-timecode">
        <span className="tc-now">{formatTC(playheadTime)}</span>
        <span className="tc-total">/ {formatTC(total)}</span>
      </div>

      <button
        className="btn icon transport-mute"
        onClick={togglePreviewMuted}
        title={previewMuted ? 'Unmute preview' : 'Mute preview'}
        disabled={!hasAudio}
      >
        {previewMuted || !hasAudio ? '🔇' : '🔊'}
      </button>
    </div>
  )
}
