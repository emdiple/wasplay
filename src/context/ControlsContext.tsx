/**
 * ControlsContext — shares the timeline viewport ref plus the zoom and transport
 * controllers with any component that needs them, without prop-drilling. Store
 * model/actions still come from `useEditorStore`; this only carries the pieces
 * that depend on DOM refs (scroll position, RAF loop).
 */

import { createContext, useContext, useMemo, useRef } from 'react'
import type { ReactNode, RefObject } from 'react'
import { useZoom } from '../hooks/useZoom'
import { useTransport } from '../hooks/useTransport'
import type { ZoomControls } from '../hooks/useZoom'
import type { TransportControls } from '../hooks/useTransport'

interface Controls {
  scrollRef: RefObject<HTMLDivElement | null>
  zoom: ZoomControls
  transport: TransportControls
}

const ControlsContext = createContext<Controls | null>(null)

export function ControlsProvider({ children }: { children: ReactNode }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const zoom = useZoom(scrollRef)
  const transport = useTransport(scrollRef)
  const value = useMemo<Controls>(() => ({ scrollRef, zoom, transport }), [zoom, transport])
  return <ControlsContext.Provider value={value}>{children}</ControlsContext.Provider>
}

export function useControls(): Controls {
  const ctx = useContext(ControlsContext)
  if (!ctx) throw new Error('useControls must be used within a ControlsProvider')
  return ctx
}
