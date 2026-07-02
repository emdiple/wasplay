import { useRef } from 'react'
import { useEditorStore } from '../store/editorStore'
import { useControls } from '../context/ControlsContext'
import { useMarquee } from '../hooks/useMarquee'
import { domainSeconds, snapTime } from '../lib/timeline'
import { Ruler } from './Ruler'
import { Track } from './Track'
import { Playhead } from './Playhead'

/** The bottom timeline: ruler, video + audio tracks, playhead, and marquee. */
export function Timeline() {
  const { scrollRef, zoom } = useControls()
  const contentRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLDivElement>(null)
  const audioRef = useRef<HTMLDivElement>(null)

  const pxPerSec = useEditorStore((s) => s.pxPerSec)
  const totalSeconds = useEditorStore((s) => domainSeconds(s.videoClips, s.audioClips))
  const { marqueeRect, beginMarquee } = useMarquee(contentRef, videoRef, audioRef)

  const handleDrop = (e: React.DragEvent) => {
    const id = e.dataTransfer.getData('text/fox-source')
    const store = useEditorStore.getState()
    const src = store.sources.find((s) => s.id === id)
    if (!src) return
    e.preventDefault()
    const content = contentRef.current
    if (!content) return
    const x = Math.max(0, e.clientX - content.getBoundingClientRect().left)
    const t = snapTime([...store.videoClips, ...store.audioClips], x / store.pxPerSec, store.pxPerSec, store.playheadTime)
    store.placeSource(src.id, t)
    store.setStage(src.id)
    zoom.fitTimeline()
  }

  return (
    <section className="timeline">
      <div className="tl-bar">
        <span className="hint">
          <b>Double-click</b> bin to append · <b>Drag</b> empty area to marquee-select · <kbd>⇧</kbd> add ·{' '}
          <b>Drag</b> clips to move · <kbd>C</kbd> razor (cuts at playhead) · <kbd>S</kbd> split all · <kbd>⌫</kbd>{' '}
          delete · <kbd>Space</kbd> play
        </span>
      </div>
      <div className="tl-body">
        <div className="gutter">
          <div className="g-ruler" />
          <div className="g-lab g-v">V</div>
          <div className="g-lab g-a">A</div>
        </div>
        <div className="tl-scroll" ref={scrollRef}>
          <div className="tl-content" ref={contentRef} style={{ width: totalSeconds * pxPerSec }}>
            <Ruler />
            <Track kind="video" trackRef={videoRef} onEmptyPointerDown={beginMarquee} onDrop={handleDrop} />
            <Track kind="audio" trackRef={audioRef} onEmptyPointerDown={beginMarquee} onDrop={handleDrop} />
            <Playhead />
            {marqueeRect && <div className="marquee" style={marqueeRect} />}
          </div>
        </div>
      </div>
    </section>
  )
}
