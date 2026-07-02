import { useEffect } from 'react'
import { useEditorStore } from './store/editorStore'
import { ControlsProvider, useControls } from './context/ControlsContext'
import { useMediaImport } from './hooks/useMediaImport'
import { useWindowFileDrop } from './hooks/useWindowFileDrop'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { TopBar } from './components/TopBar'
import { MediaBin } from './components/MediaBin'
import { Preview } from './components/Preview'
import { Timeline } from './components/Timeline'
import { DropOverlay, LoadingOverlay } from './components/Overlays'
import { AnalyzerPanel } from './components/AnalyzerPanel'
import { ClipContextMenu } from './components/ClipContextMenu'
import { ExportDialog } from './components/ExportDialog'

export function App() {
  return (
    <ControlsProvider>
      <Editor />
    </ControlsProvider>
  )
}

/** The editor shell: top bar, media bin + preview, timeline, and overlays. */
function Editor() {
  const importFiles = useMediaImport()
  const dragging = useWindowFileDrop(importFiles)
  const { transport, zoom } = useControls()
  useKeyboardShortcuts(transport)

  const followOsTheme = useEditorStore((s) => s.followOsTheme)

  // The active theme is reflected onto <html data-theme> by a store subscription
  // in main.tsx (synchronous, so canvas redraws read the right colours).
  // Follow OS theme changes until the user manually toggles (store guards this).
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: light)')
    const onChange = (e: MediaQueryListEvent) => followOsTheme(e.matches ? 'light' : 'dark')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [followOsTheme])

  // Start with the whole (fit-to-view) domain visible, once the timeline mounts.
  useEffect(() => {
    zoom.fitTimeline()
  }, [zoom])

  return (
    <>
      <TopBar importFiles={importFiles} />
      <section className="middle">
        <MediaBin />
        <Preview />
      </section>
      <Timeline />
      <DropOverlay visible={dragging} />
      <LoadingOverlay />
      <AnalyzerPanel />
      <ClipContextMenu />
      <ExportDialog />
    </>
  )
}
