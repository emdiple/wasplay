import { useEditorStore } from '../store/editorStore'

/** Full-window overlay shown while files are dragged over the app. */
export function DropOverlay({ visible }: { visible: boolean }) {
  if (!visible) return null
  return <div className="drop-overlay">Drop media to import</div>
}

/** Blocking overlay shown while media decodes (locks the app). */
export function LoadingOverlay() {
  const busy = useEditorStore((s) => s.busy)
  const msg = useEditorStore((s) => s.loadingMsg)
  if (!busy) return null
  return (
    <div className="loading-overlay">
      <div className="spinner" />
      <div className="loading-msg">{msg}</div>
      <div className="loading-sub">Decoding waveform &amp; thumbnails — please wait</div>
    </div>
  )
}
