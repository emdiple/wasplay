import { useRef } from 'react'
import { useEditorStore } from '../store/editorStore'
import { useControls } from '../context/ControlsContext'
import { useMarquee } from '../hooks/useMarquee'
import { useMediaQuery, COMPACT_QUERY } from '../hooks/useMediaQuery'
import { domainSeconds, snapTime } from '../lib/timeline'
import { Ruler } from './Ruler'
import { Track } from './Track'
import { Playhead } from './Playhead'
import { ClipInspector, hasClipSelection } from './ClipInspector'
import type { TimelineTrack } from '../types'

/** The bottom timeline: ruler, layer tracks, playhead, and marquee. */
export function Timeline() {
  const { scrollRef, zoom } = useControls()
  const contentRef = useRef<HTMLDivElement>(null)

  // Two-finger pinch on the timeline = zoom (pxPerSec), anchored at the pinch
  // midpoint. Only touch pointers that aren't grabbing a clip or the ruler
  // participate; single-finger drags pan natively via touch-action (CSS).
  const pinchPointers = useRef(new Map<number, { x: number; y: number }>())
  const pinchStart = useRef<{ dist: number; px: number; midTime: number; midX: number } | null>(null)

  const pinchable = (e: React.PointerEvent) =>
    e.pointerType === 'touch' && !(e.target as Element).closest('.clip, .ruler-canvas')

  const onPinchDown = (e: React.PointerEvent) => {
    if (!pinchable(e)) return
    pinchPointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pinchPointers.current.size === 2 && scrollRef.current) {
      const [a, b] = [...pinchPointers.current.values()]
      const scroll = scrollRef.current
      const midX = (a.x + b.x) / 2 - scroll.getBoundingClientRect().left
      const px = useEditorStore.getState().pxPerSec
      pinchStart.current = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        px,
        midTime: (scroll.scrollLeft + midX) / px,
        midX,
      }
    }
  }

  const onPinchMove = (e: React.PointerEvent) => {
    if (!pinchPointers.current.has(e.pointerId)) return
    pinchPointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const start = pinchStart.current
    if (!start || pinchPointers.current.size !== 2 || !scrollRef.current) return
    const [a, b] = [...pinchPointers.current.values()]
    const dist = Math.hypot(a.x - b.x, a.y - b.y)
    if (dist < 1) return
    zoom.setZoom(start.px * (dist / start.dist))
    // Keep the time under the pinch midpoint stationary as the scale changes.
    const npx = useEditorStore.getState().pxPerSec
    scrollRef.current.scrollLeft = Math.max(0, start.midTime * npx - start.midX)
  }

  const onPinchEnd = (e: React.PointerEvent) => {
    pinchPointers.current.delete(e.pointerId)
    if (pinchPointers.current.size < 2) pinchStart.current = null
  }

  const pxPerSec = useEditorStore((s) => s.pxPerSec)
  const totalSeconds = useEditorStore((s) => domainSeconds(s.videoClips, s.audioClips))
  const showInspector = useEditorStore((s) => hasClipSelection(s.selection, s.videoClips, s.audioClips))
  const splitAtPlayhead = useEditorStore((s) => s.splitAtPlayhead)
  const tracks = useEditorStore((s) => s.tracks)
  const addTrack = useEditorStore((s) => s.addTrack)
  const removeTrack = useEditorStore((s) => s.removeTrack)
  const compact = useMediaQuery(COMPACT_QUERY)
  const zoomLabel = (pxPerSec < 10 ? pxPerSec.toFixed(1) : Math.round(pxPerSec)) + ' px/s'
  const { marqueeRect, beginMarquee } = useMarquee(contentRef)

  // Row order mirrors pro NLEs: video layers top-down from the highest (V2 over
  // V1), audio layers top-down from A1. Store order within a kind is V1→Vn.
  const videoTracks = tracks.filter((t) => t.kind === 'video')
  const audioTracks = tracks.filter((t) => t.kind === 'audio')
  const rows: { track: TimelineTrack; label: string; removable: boolean }[] = [
    ...[...videoTracks].reverse().map((t) => ({
      track: t,
      label: `V${videoTracks.indexOf(t) + 1}`,
      removable: videoTracks.length > 1,
    })),
    ...audioTracks.map((t) => ({
      track: t,
      label: `A${audioTracks.indexOf(t) + 1}`,
      removable: audioTracks.length > 1,
    })),
  ]

  const handleDrop = (e: React.DragEvent, track: TimelineTrack) => {
    const id = e.dataTransfer.getData('text/waz-source')
    const store = useEditorStore.getState()
    const src = store.sources.find((s) => s.id === id)
    if (!src) return
    e.preventDefault()
    const content = contentRef.current
    if (!content) return
    const x = Math.max(0, e.clientX - content.getBoundingClientRect().left)
    const t = snapTime([...store.videoClips, ...store.audioClips], x / store.pxPerSec, store.pxPerSec, store.playheadTime)
    // The dropped-on lane receives the matching half; the other half of an A/V
    // source lands on the first lane of its kind.
    store.placeSource(src.id, t, {
      videoTrackId: track.kind === 'video' ? track.id : undefined,
      audioTrackId: track.kind === 'audio' ? track.id : undefined,
    })
    store.setStage(src.id)
    zoom.fitTimeline()
  }

  return (
    <section
      className="timeline"
      style={{ '--vtracks': videoTracks.length, '--atracks': audioTracks.length } as React.CSSProperties}
    >
      <div className="tl-bar">
        {compact ? (
          // Mobile: the per-clip audio strip lives here (no room for a side panel).
          showInspector ? (
            <ClipInspector />
          ) : (
            <span className="hint">
              <b>Tap</b> a clip to select · <b>drag</b> to move · <b>long-press</b> for menu · <b>pinch</b> to zoom
            </span>
          )
        ) : (
          <div className="tl-toolbar">
            <div className="toolbar-group">
              <button className="btn icon" title="Split at playhead (S)" onClick={splitAtPlayhead}>
                ⑂ <span className="btn-label">Split</span>
              </button>
              <button className="btn icon" title="Add video track" onClick={() => addTrack('video')}>
                ＋V
              </button>
              <button className="btn icon" title="Add audio track" onClick={() => addTrack('audio')}>
                ＋A
              </button>
            </div>
            <span className="hint">
              <b>Drag</b> empty area to marquee · <kbd>⇧</kbd> add · <b>drag</b> clips to move · <kbd>C</kbd> razor ·{' '}
              <kbd>Space</kbd> play · <kbd>←/→</kbd> frame
            </span>
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
          </div>
        )}
      </div>
      <div className="tl-body">
        <div className="gutter">
          <div className="g-ruler" />
          {rows.map(({ track, label, removable }) => (
            <div className={`g-lab g-${track.kind === 'video' ? 'v' : 'a'}`} key={track.id}>
              <span>{label}</span>
              {removable && (
                <button
                  className="g-remove"
                  title={`Remove ${label} (and its clips)`}
                  onClick={() => removeTrack(track.id)}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
        <div
          className="tl-scroll"
          ref={scrollRef}
          onPointerDown={onPinchDown}
          onPointerMove={onPinchMove}
          onPointerUp={onPinchEnd}
          onPointerCancel={onPinchEnd}
        >
          <div className="tl-content" ref={contentRef} style={{ width: totalSeconds * pxPerSec }}>
            <Ruler />
            {rows.map(({ track }) => (
              <Track key={track.id} track={track} onEmptyPointerDown={beginMarquee} onDrop={handleDrop} />
            ))}
            <Playhead />
            {marqueeRect && <div className="marquee" style={marqueeRect} />}
          </div>
        </div>
      </div>
    </section>
  )
}
