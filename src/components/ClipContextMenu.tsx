import { useEffect, useRef } from 'react'
import { useEditorStore } from '../store/editorStore'
import { linkedPartner, reattachCandidate } from '../lib/timeline'
import { precedingClip } from '../lib/transition'

/** Default dissolve length (seconds) when added from the menu; tweak in the Inspector. */
const DEFAULT_DISSOLVE_S = 1

/** Right-click menu for a clip: detach or re-attach its linked A/V partner, add/remove a dissolve, or reorder it among overlapping clips. */
export function ClipContextMenu() {
  const menuRef = useRef<HTMLDivElement>(null)
  const contextMenu = useEditorStore((s) => s.contextMenu)
  const clip = useEditorStore((s) => s.contextMenu && [...s.videoClips, ...s.audioClips].find((c) => c.id === s.contextMenu!.clipId))
  const onVideoTrack = useEditorStore((s) => !!s.contextMenu && s.videoClips.some((c) => c.id === s.contextMenu!.clipId))
  const partner = useEditorStore((s) => (clip ? linkedPartner(clip, s.videoClips, s.audioClips) : null))
  const reattach = useEditorStore((s) => (clip ? reattachCandidate(clip, s.videoClips, s.audioClips) : null))
  // A dissolve needs an adjacent predecessor on the clicked clip's own track.
  const hasPredecessor = useEditorStore((s) =>
    clip ? !!precedingClip(onVideoTrack ? s.videoClips : s.audioClips, clip) : false,
  )
  const closeContextMenu = useEditorStore((s) => s.closeContextMenu)
  const detachPartner = useEditorStore((s) => s.detachPartner)
  const linkClips = useEditorStore((s) => s.linkClips)
  const setClipTransition = useEditorStore((s) => s.setClipTransition)
  const removeClipTransition = useEditorStore((s) => s.removeClipTransition)
  const setStatus = useEditorStore((s) => s.setStatus)
  const bringToFront = useEditorStore((s) => s.bringToFront)
  const sendToBack = useEditorStore((s) => s.sendToBack)

  useEffect(() => {
    if (!contextMenu) return
    const onPointerDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) closeContextMenu()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeContextMenu()
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [contextMenu, closeContextMenu])

  if (!contextMenu || !clip) return null

  const clipId = clip.id
  const detachLabel = onVideoTrack ? 'Detach audio' : 'Detach video'
  const reattachLabel = onVideoTrack ? 'Re-attach audio' : 'Re-attach video'
  const showLinkRow = !!partner || !!reattach // hide the row when there's nothing to detach or re-attach
  const hasDissolve = !!clip.transitionIn

  const run = (action: () => void) => () => {
    action()
    closeContextMenu()
  }

  const addDissolve = () => {
    if (!setClipTransition(clipId, DEFAULT_DISSOLVE_S)) {
      setStatus('Place a clip directly before this one to dissolve into it.')
    }
  }

  return (
    <div ref={menuRef} className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
      {partner ? (
        <button className="context-menu-item" onClick={run(() => detachPartner(clipId))}>
          {detachLabel}
        </button>
      ) : (
        reattach && (
          <button className="context-menu-item" onClick={run(() => linkClips(clipId, reattach.id))}>
            {reattachLabel}
          </button>
        )
      )}
      {showLinkRow && <div className="context-menu-sep" />}
      {hasDissolve ? (
        <button className="context-menu-item" onClick={run(() => removeClipTransition(clipId))}>
          Remove dissolve
        </button>
      ) : (
        hasPredecessor && (
          <button className="context-menu-item" onClick={run(addDissolve)}>
            Add dissolve
          </button>
        )
      )}
      {(hasDissolve || hasPredecessor) && <div className="context-menu-sep" />}
      <button className="context-menu-item" onClick={run(() => bringToFront(clipId))}>
        Bring to front
      </button>
      <button className="context-menu-item" onClick={run(() => sendToBack(clipId))}>
        Send to back
      </button>
    </div>
  )
}
