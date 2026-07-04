import { useEffect, useRef, type CSSProperties } from 'react'
import { useEditorStore } from './store/editorStore'
import { ControlsProvider, useControls } from './context/ControlsContext'
import { useMediaImport } from './hooks/useMediaImport'
import { useWindowFileDrop } from './hooks/useWindowFileDrop'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { useMediaQuery, COMPACT_QUERY } from './hooks/useMediaQuery'
import { TopBar } from './components/TopBar'
import { ToolRail } from './components/ToolRail'
import { MediaBin } from './components/MediaBin'
import { Preview } from './components/Preview'
import { Timeline } from './components/Timeline'
import { Resizer } from './components/Resizer'
import { Inspector } from './components/Inspector'
import { DropOverlay, LoadingOverlay } from './components/Overlays'
import { AnalyzerPanel } from './components/AnalyzerPanel'
import { ClipContextMenu } from './components/ClipContextMenu'
import { ExportDialog } from './components/ExportDialog'

// Default track heights the trackScale multiplier is applied to (mirror global.css).
const BASE_VTRACK = 92
const BASE_ATRACK = 64

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

  // Resizable panels — inert in the mobile "stacked" layout, where the media
  // bin is a bottom sheet and track heights come from CSS media queries.
  const compact = useMediaQuery(COMPACT_QUERY)
  const binW = useEditorStore((s) => s.binW)
  const trackScale = useEditorStore((s) => s.trackScale)
  const inspectorW = useEditorStore((s) => s.inspectorW)
  const inspectorOpen = useEditorStore((s) => s.inspectorOpen)
  const setBinW = useEditorStore((s) => s.setBinW)
  const setTrackScale = useEditorStore((s) => s.setTrackScale)
  const setInspectorW = useEditorStore((s) => s.setInspectorW)
  const dragStart = useRef(0)
  const inspStart = useRef(0)

  // Custom sizes are applied only off-mobile, so the CSS media queries stay
  // authoritative on phones (inline vars would otherwise beat them).
  const shellVars: CSSProperties | undefined = compact
    ? undefined
    : ({
        '--bin-w': `${binW}px`,
        '--inspector-w': `${inspectorW}px`,
        '--vtrack-h': `${Math.round(BASE_VTRACK * trackScale)}px`,
        '--atrack-h': `${Math.round(BASE_ATRACK * trackScale)}px`,
      } as CSSProperties)

  return (
    <div className="editor-shell" style={shellVars}>
      <TopBar importFiles={importFiles} />
      <section className="middle">
        <ToolRail />
        <MediaBin />
        {!compact && (
          <Resizer
            axis="x"
            title="Drag to resize the media bin · double-click to reset"
            onStart={() => (dragStart.current = useEditorStore.getState().binW)}
            onDrag={(dx) => setBinW(dragStart.current + dx)}
            onReset={() => setBinW(260)}
          />
        )}
        <Preview />
        {!compact && inspectorOpen && (
          <Resizer
            axis="x"
            title="Drag to resize the inspector · double-click to reset"
            onStart={() => (inspStart.current = useEditorStore.getState().inspectorW)}
            // Inspector is on the right: dragging left (negative dx) widens it.
            onDrag={(dx) => setInspectorW(inspStart.current - dx)}
            onReset={() => setInspectorW(300)}
          />
        )}
        {!compact && inspectorOpen && <Inspector />}
      </section>
      {!compact && (
        <Resizer
          axis="y"
          title="Drag to resize the timeline · double-click to reset"
          onStart={() => (dragStart.current = useEditorStore.getState().trackScale)}
          // Drag up (negative dy) grows the timeline; ~150px of travel per 1× scale.
          onDrag={(dy) => setTrackScale(dragStart.current - dy / 150)}
          onReset={() => setTrackScale(1)}
        />
      )}
      <Timeline />
      <DropOverlay visible={dragging} />
      <LoadingOverlay />
      {compact && <AnalyzerPanel />}
      <ClipContextMenu />
      <ExportDialog />
    </div>
  )
}
