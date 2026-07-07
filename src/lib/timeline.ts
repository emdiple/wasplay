/**
 * Pure timeline math — track extents, snapping, and link-group splitting.
 *
 * All functions are pure: the split helpers return fresh clip arrays rather than
 * mutating, so the editor store can treat updates immutably.
 */

import type { Clip, TimelineTrack } from '../types'
import { uid } from './id'
import { clampFades } from './fade'

/** The timeline is always at least this long (1 minute)… */
export const DOMAIN_MIN_S = 60

/** …but expands to cover the furthest clip end, so long media fits fully. */
export const trackEnd = (clips: Clip[]): number => clips.reduce((m, c) => Math.max(m, c.start + c.dur), 0)

export const timelineEnd = (video: Clip[], audio: Clip[]): number => Math.max(trackEnd(video), trackEnd(audio))

export const domainSeconds = (video: Clip[], audio: Clip[]): number => Math.max(DOMAIN_MIN_S, timelineEnd(video, audio))

export const byStart = (clips: Clip[]): Clip[] => [...clips].sort((a, b) => a.start - b.start)

/** How close (in seconds) an edge must be to an anchor to snap, at a given zoom. */
const snapThreshold = (pxPerSec: number) => 8 / pxPerSec

/**
 * Snap a clip's new start so either of its edges lands on 0, the playhead, or
 * another clip's edge. Clips in `excludeIds` (the moving group) are ignored so a
 * clip can't snap to itself or to the others being dragged with it.
 */
export function snapEdges(
  allClips: Clip[],
  newStart: number,
  clip: Clip,
  excludeIds: Set<string>,
  pxPerSec: number,
  playheadTime: number,
): number {
  const thr = snapThreshold(pxPerSec)
  const anchors = [0, playheadTime]
  for (const c of allClips) if (!excludeIds.has(c.id)) anchors.push(c.start, c.start + c.dur)

  let bestDelta = 0
  let bestDist = thr
  for (const edge of [newStart, newStart + clip.dur]) {
    for (const a of anchors) {
      const d = Math.abs(edge - a)
      if (d < bestDist) {
        bestDist = d
        bestDelta = a - edge
      }
    }
  }
  return Math.max(0, newStart + bestDelta)
}

/** Snap a bare time value to 0, the playhead, or any clip edge (for drops/scrub). */
export function snapTime(allClips: Clip[], t: number, pxPerSec: number, playheadTime: number): number {
  const thr = snapThreshold(pxPerSec)
  const anchors = [0, playheadTime]
  for (const c of allClips) anchors.push(c.start, c.start + c.dur)

  let best = t
  let bestDist = thr
  for (const a of anchors) {
    const d = Math.abs(t - a)
    if (d < bestDist) {
      bestDist = d
      best = a
    }
  }
  return Math.max(0, best)
}

/**
 * Split every clip in a link group at time `t`, across both tracks. The left
 * halves keep the old link; all right halves share one new link, so an A/V pair
 * stays paired after the cut.
 *
 * Returns fresh track arrays plus the newly created right-hand clips (empty when
 * `t` fell outside every clip in the group).
 */
export function splitLinkGroupAt(
  video: Clip[],
  audio: Clip[],
  link: string,
  t: number,
): { video: Clip[]; audio: Clip[]; rights: Clip[] } {
  const eps = 0.02
  const newLink = uid()
  const rights: Clip[] = []

  const splitTrack = (clips: Clip[]): Clip[] => {
    const out: Clip[] = []
    for (const c of clips) {
      const insideThisGroup = c.link === link && t > c.start + eps && t < c.start + c.dur - eps
      if (insideThisGroup) {
        const offset = t - c.start
        // Fades split with the cut: the left half keeps the fade-in, the right
        // half keeps the fade-out, each re-clamped to its now-shorter length.
        const leftFade = clampFades(offset, c.fadeIn, 0)
        const rightFade = clampFades(c.dur - offset, 0, c.fadeOut)
        const left: Clip = { ...c, dur: offset, fadeIn: leftFade.fadeIn, fadeOut: 0 }
        const right: Clip = {
          id: uid(),
          sourceId: c.sourceId,
          link: newLink,
          trackId: c.trackId, // a cut never changes layers
          start: t,
          in: c.in + offset,
          dur: c.dur - offset,
          z: c.z, // keep the same stacking order as the clip it was cut from
          gainDb: c.gainDb, // both halves inherit the parent clip's level
          fadeIn: 0,
          fadeOut: rightFade.fadeOut,
        }
        rights.push(right)
        out.push(left, right)
      } else {
        out.push(c)
      }
    }
    return out
  }

  return { video: splitTrack(video), audio: splitTrack(audio), rights }
}

/** All link ids whose clips the time `t` passes through (for split-all). */
export function linksAtTime(video: Clip[], audio: Clip[], t: number): Set<string> {
  const eps = 0.02
  const links = new Set<string>()
  for (const c of [...video, ...audio]) {
    if (t > c.start + eps && t < c.start + c.dur - eps) links.add(c.link)
  }
  return links
}

/**
 * Expand a set of clip ids to include every clip that shares a `link` with any
 * id already in the set — so selecting, dragging, or deleting one half of a
 * linked A/V pair always carries the other half along.
 */
export function expandToLinkGroups(allClips: Clip[], ids: Set<string>): Set<string> {
  const links = new Set<string>()
  for (const c of allClips) if (ids.has(c.id)) links.add(c.link)

  const expanded = new Set<string>()
  for (const c of allClips) if (links.has(c.link)) expanded.add(c.id)
  return expanded
}

/** The clip on a track whose span covers time `t`, if any. */
export function clipAtTime(clips: Clip[], t: number): Clip | null {
  for (const c of clips) if (t >= c.start && t < c.start + c.dur) return c
  return null
}

/**
 * Layer priority per track id: within a kind, a later position in the tracks
 * list is a higher layer (V2 composites above V1). The raw list index works as
 * the priority since same-kind relative order is all comparisons ever use.
 */
export const trackPriority = (tracks: TimelineTrack[]): Map<string, number> =>
  new Map(tracks.map((t, i) => [t.id, i]))

/**
 * The clip that wins at time `t` across every layer of one kind: highest track
 * priority first, then highest within-track z. This is what the program monitor
 * shows and what the export compositor paints on top.
 */
export function topmostClipAt(clips: Clip[], priority: Map<string, number>, t: number): Clip | null {
  let best: Clip | null = null
  for (const c of clips) {
    if (t < c.start || t >= c.start + c.dur) continue
    if (!best) {
      best = c
      continue
    }
    const pc = priority.get(c.trackId) ?? 0
    const pb = priority.get(best.trackId) ?? 0
    if (pc > pb || (pc === pb && c.z > best.z)) best = c
  }
  return best
}

/**
 * The clip on the opposite track that shares `clip`'s link id (its linked A/V
 * partner), or null if `clip` has already been detached / has none.
 */
export function linkedPartner(clip: Clip, video: Clip[], audio: Clip[]): Clip | null {
  const onVideoTrack = video.some((c) => c.id === clip.id)
  const otherTrack = onVideoTrack ? audio : video
  return otherTrack.find((c) => c.link === clip.link) ?? null
}

/**
 * A currently-detached, same-source clip on the opposite track that `clip` can
 * be re-attached to (reversing a detach). Returns null when `clip` is already
 * linked or has no partnerless same-source counterpart. When several qualify,
 * the temporally nearest is chosen — normally the very clip just detached.
 * Re-attaching links them where they now sit; it never moves them.
 */
export function reattachCandidate(clip: Clip, video: Clip[], audio: Clip[]): Clip | null {
  if (linkedPartner(clip, video, audio)) return null // already attached
  const onVideoTrack = video.some((c) => c.id === clip.id)
  const otherTrack = onVideoTrack ? audio : video
  const candidates = otherTrack.filter(
    (c) => c.sourceId === clip.sourceId && linkedPartner(c, video, audio) === null,
  )
  if (!candidates.length) return null

  let best = candidates[0]
  let bestDist = Math.abs(best.start - clip.start)
  for (const c of candidates) {
    const d = Math.abs(c.start - clip.start)
    if (d < bestDist) {
      bestDist = d
      best = c
    }
  }
  return best
}
