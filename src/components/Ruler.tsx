import { useEffect, useRef } from 'react'
import { useEditorStore } from '../store/editorStore'
import { domainSeconds } from '../lib/timeline'
import { formatClock } from '../lib/format'
import { cssVar } from '../lib/themeColors'

const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600]

/** Time ruler across the top of the timeline. Click/drag to scrub the playhead. */
export function Ruler() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pxPerSec = useEditorStore((s) => s.pxPerSec)
  const totalSeconds = useEditorStore((s) => domainSeconds(s.videoClips, s.audioClips))
  const theme = useEditorStore((s) => s.theme) // redraw with new colours on theme change

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const cssW = totalSeconds * pxPerSec
    const dpr = window.devicePixelRatio || 1
    const W = Math.min(cssW, 32000)

    canvas.width = Math.round(W * dpr)
    canvas.height = Math.round(26 * dpr)
    canvas.style.width = W + 'px'
    canvas.style.height = '26px'

    const bg = cssVar('--ruler-bg')
    const tick = cssVar('--ruler-tick')
    const tickMinor = cssVar('--ruler-tick-minor')
    const text = cssVar('--ruler-text')

    const ctx = canvas.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, W, 26)

    const step = STEPS.find((s) => s * pxPerSec >= 64) || 3600
    ctx.strokeStyle = tick
    ctx.fillStyle = text
    ctx.font = '10px "SF Mono", monospace'
    ctx.lineWidth = 1

    for (let t = 0; t * pxPerSec <= W; t += step) {
      const x = Math.round(t * pxPerSec) + 0.5
      ctx.beginPath()
      ctx.moveTo(x, 13)
      ctx.lineTo(x, 26)
      ctx.stroke()
      ctx.fillText(formatClock(t), x + 4, 11)
      // half-step minor tick
      const hx = Math.round((t + step / 2) * pxPerSec) + 0.5
      ctx.strokeStyle = tickMinor
      ctx.beginPath()
      ctx.moveTo(hx, 19)
      ctx.lineTo(hx, 26)
      ctx.stroke()
      ctx.strokeStyle = tick
    }
  }, [pxPerSec, totalSeconds, theme])

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = e.currentTarget
    canvas.setPointerCapture(e.pointerId)
    const { setPlayhead } = useEditorStore.getState()

    const scrub = (clientX: number) => {
      const left = canvas.getBoundingClientRect().left
      const x = Math.max(0, clientX - left)
      setPlayhead(Math.min(totalSeconds, x / pxPerSec))
    }
    scrub(e.clientX)

    const onMove = (ev: PointerEvent) => scrub(ev.clientX)
    const onUp = () => {
      canvas.releasePointerCapture(e.pointerId)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
    }
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
  }

  return <canvas className="ruler-canvas" ref={canvasRef} onPointerDown={onPointerDown} />
}
