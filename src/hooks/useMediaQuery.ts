import { useSyncExternalStore } from 'react'

/**
 * Subscribe to a CSS media query and re-render on change. Uses
 * useSyncExternalStore so it stays correct across concurrent renders.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = matchMedia(query)
      mq.addEventListener('change', cb)
      return () => mq.removeEventListener('change', cb)
    },
    () => matchMedia(query).matches,
    () => false, // SSR fallback (never hit here, but required)
  )
}

/** The mobile "stacked" layout regime, where resizable panels are disabled. */
export const COMPACT_QUERY = '(max-width: 600px), (max-height: 500px)'
