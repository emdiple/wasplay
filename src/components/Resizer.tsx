import type { PointerEvent as ReactPointerEvent } from 'react'

interface ResizerProps {
  /** Axis of movement: 'x' = drag left/right (bin width), 'y' = drag up/down (timeline height). */
  axis: 'x' | 'y'
  /** Captures the value to resize from, at the moment the drag starts. */
  onStart: () => void
  /** Called on every move with the total pixel delta since the drag started. */
  onDrag: (delta: number) => void
  /** Reset to default (double-click / double-tap). */
  onReset?: () => void
  title?: string
}

/**
 * A draggable panel divider (like Spotify's resizable sidebars). Uses pointer
 * capture so the drag survives fast movement, and a body class to freeze the
 * cursor + kill text selection while dragging. Works with mouse, touch and pen.
 */
export function Resizer({ axis, onStart, onDrag, onReset, title }: ResizerProps) {
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const el = e.currentTarget
    const origin = axis === 'x' ? e.clientX : e.clientY
    onStart()
    el.setPointerCapture(e.pointerId)
    document.body.classList.add(axis === 'x' ? 'resizing-x' : 'resizing-y')

    const move = (ev: PointerEvent) => onDrag((axis === 'x' ? ev.clientX : ev.clientY) - origin)
    const up = () => {
      el.releasePointerCapture(e.pointerId)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      document.body.classList.remove('resizing-x', 'resizing-y')
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  return (
    <div
      className={`resizer resizer-${axis}`}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      title={title ?? 'Drag to resize · double-click to reset'}
      onPointerDown={down}
      onDoubleClick={onReset}
    >
      <span className="resizer-grip" aria-hidden />
    </div>
  )
}
