import { useEffect, useRef, useState } from 'react'
import { useEditorStore } from '../store/editorStore'
import { fox } from '../wasm/foxClient'
import { formatTime } from '../lib/format'
import { cssVar } from '../lib/themeColors'
import type { MediaInfo, Source } from '../types'

const TARGET_LUFS = -23.0

/**
 * The media analyzer, folded in as a modal panel. Reuses the waveform peaks and
 * thumbnails already decoded for the source, and measures integrated loudness
 * (EBU R128) on open.
 */
export function AnalyzerPanel() {
  const analyzerSrcId = useEditorStore((s) => s.analyzerSrcId)
  const src = useEditorStore((s) => s.sources.find((x) => x.id === s.analyzerSrcId) ?? null)
  const closeAnalyzer = useEditorStore((s) => s.closeAnalyzer)

  if (!analyzerSrcId || !src) return null

  return (
    <div className="analyzer-overlay" onClick={closeAnalyzer}>
      <div className="analyzer" onClick={(e) => e.stopPropagation()}>
        <div className="analyzer-head">
          <span className="analyzer-title">{src.name}</span>
          <button className="btn icon" onClick={closeAnalyzer} title="Close">
            ✕
          </button>
        </div>
        {src.info && <CodecBadges info={src.info} />}
        <Loudness src={src} key={src.id} />
        {src.peaks && <Waveform peaks={src.peaks} />}
        {src.thumbs && src.thumbs.length > 0 && <ThumbnailStrip src={src} />}
      </div>
    </div>
  )
}

function CodecBadges({ info }: { info: MediaInfo }) {
  const items: [string, string | null, string][] = [
    ['Container', info.container, 'container'],
    ['Audio', info.audio_codec, 'audio'],
  ]
  if (info.video_codec) items.push(['Video', info.video_codec, 'video'])
  if (info.channels != null) {
    const chLabel = info.channels === 1 ? 'Mono' : info.channels === 2 ? 'Stereo' : `${info.channels}ch`
    items.push(['Channels', chLabel, ''])
  }
  if (info.sample_rate != null) items.push(['Sample Rate', `${(info.sample_rate / 1000).toFixed(1)} kHz`, ''])
  if (info.bits_per_sample != null) items.push(['Bit Depth', `${info.bits_per_sample}-bit`, ''])

  return (
    <div className="panel">
      <div className="panel-label">Codec / Container</div>
      <div className="badges">
        {items.map(([label, val, cls]) => (
          <div className="badge-item" key={label}>
            <span className="label">{label}</span>
            <span className={'val ' + cls}>{val ?? '—'}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function Loudness({ src }: { src: Source }) {
  const [lufs, setLufs] = useState<number | null | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    setLufs(undefined)
    fox
      .lufs(src.file)
      .then((v) => !cancelled && setLufs(v))
      .catch(() => !cancelled && setLufs(null))
    return () => {
      cancelled = true
    }
  }, [src])

  let lufsText = '…'
  let lufsClass = 'value'
  let gainText = '—'
  let gainClass = 'value'
  if (lufs !== undefined) {
    if (lufs === null || !Number.isFinite(lufs)) {
      lufsText = '−∞'
    } else {
      const gain = TARGET_LUFS - lufs
      lufsText = `${lufs.toFixed(2)} LUFS`
      lufsClass = 'value' + (lufs > -14 ? ' warn' : '')
      gainText = `${gain >= 0 ? '+' : ''}${gain.toFixed(2)} dB`
      gainClass = 'value ' + (gain > 0 ? 'boost' : 'ok')
    }
  }

  return (
    <div className="panel">
      <div className="panel-label">Loudness (EBU R128)</div>
      <div className="metrics">
        <div className="metric">
          <div className="label">Integrated</div>
          <div className={lufsClass}>{lufsText}</div>
        </div>
        <div className="metric">
          <div className="label">Target</div>
          <div className="value">−23.0 LUFS</div>
        </div>
        <div className="metric">
          <div className="label">Gain to Target</div>
          <div className={gainClass}>{gainText}</div>
        </div>
      </div>
    </div>
  )
}

function Waveform({ peaks }: { peaks: Float32Array }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const theme = useEditorStore((s) => s.theme)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const W = Math.max(1, Math.round(canvas.clientWidth * dpr))
    const H = Math.round(100 * dpr)
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext('2d')!
    const mid = H / 2
    ctx.fillStyle = cssVar('--canvas-bg')
    ctx.fillRect(0, 0, W, H)
    ctx.strokeStyle = cssVar('--wave-baseline')
    ctx.beginPath()
    ctx.moveTo(0, mid)
    ctx.lineTo(W, mid)
    ctx.stroke()

    const edge = cssVar('--wave-edge')
    const midColor = cssVar('--wave-mid')
    const grad = ctx.createLinearGradient(0, 0, 0, H)
    grad.addColorStop(0, edge)
    grad.addColorStop(0.45, midColor)
    grad.addColorStop(0.5, midColor)
    grad.addColorStop(1, edge)
    ctx.fillStyle = grad
    for (let x = 0; x < W; x++) {
      const idx = Math.min(peaks.length - 1, Math.floor((x / W) * peaks.length))
      const h = Math.max(1, peaks[idx] * mid)
      ctx.fillRect(x, mid - h, 1, h * 2)
    }
  }, [peaks, theme])

  return (
    <div className="panel">
      <div className="panel-label">Waveform</div>
      <canvas className="analyzer-wave" ref={canvasRef} />
    </div>
  )
}

function ThumbnailStrip({ src }: { src: Source }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const theme = useEditorStore((s) => s.theme)

  useEffect(() => {
    const canvas = canvasRef.current
    const thumbs = src.thumbs
    if (!canvas || !thumbs || !thumbs.length) return
    const dpr = window.devicePixelRatio || 1
    const stripCssW = canvas.clientWidth || 680
    const count = thumbs.length
    const thumbCssW = Math.floor(stripCssW / count)
    const thumbCssH = Math.round(thumbCssW * ((src.height || 9) / (src.width || 16)))

    const W = Math.round(stripCssW * dpr)
    const H = Math.round(thumbCssH * dpr)
    const tw = Math.round(thumbCssW * dpr)
    canvas.width = W
    canvas.height = H
    canvas.style.height = thumbCssH + 'px'

    const bg = cssVar('--canvas-bg')
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, W, H)
    thumbs.forEach(({ bitmap, timestamp_s }, i) => {
      const x = i * tw
      try {
        ctx.drawImage(bitmap, x, 0, tw, H) // shared with the timeline — do not close
      } catch {
        /* bitmap gone */
      }
      if (i > 0) {
        ctx.fillStyle = bg
        ctx.fillRect(x, 0, 1, H)
      }
      // Labels overlay arbitrary thumbnail images, so keep a fixed dark chip +
      // light text regardless of theme (stays legible on any frame).
      const label = formatTime(timestamp_s)
      const pad = Math.round(3 * dpr)
      const fsize = Math.round(9 * dpr)
      ctx.font = `${fsize}px "SF Mono", "Fira Code", monospace`
      const labelW = ctx.measureText(label).width
      ctx.fillStyle = 'rgba(0,0,0,0.6)'
      ctx.fillRect(x + pad, H - fsize - pad * 2, labelW + pad * 2, fsize + pad * 2)
      ctx.fillStyle = '#e8eaf0'
      ctx.fillText(label, x + pad * 2, H - pad * 2)
    })
  }, [src, theme])

  return (
    <div className="panel">
      <div className="panel-label">Timeline Thumbnails</div>
      <canvas className="analyzer-thumbs" ref={canvasRef} />
    </div>
  )
}
