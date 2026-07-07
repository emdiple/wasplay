/**
 * Pure transition (cross-dissolve) math and geometry.
 *
 * Model: a dissolve of length `d` on an incoming clip B means B overlaps its
 * predecessor A on B's first `d` seconds — created not by media handles (clips
 * here are usually placed whole, with none) but by a "ripple slide": B and every
 * clip after it move left by `d`, so A's real tail and B's real head coincide.
 * At render time B carries `transitionIn = { dur: d }`; the "from" clip A is
 * whatever span sits under B at the instant B begins.
 *
 * Everything here is framework-free so the timeline store, the export renderers,
 * and the live preview all agree on where a transition is and who crosses into
 * whom. Positional lookups use `Span` so they work for both `Clip` and `EdlEvent`.
 */

import type { Clip, Transition } from '../types'

/** Longest a dissolve may be, in seconds — a UI guardrail. */
export const MAX_DISSOLVE_S = 5

const EPS = 0.02
/** How close two clip edges must be to count as an adjacent cut. */
const ADJ_TOL = 0.05

/** Minimal positional span, satisfied by both `Clip` (via clipSpan) and `EdlEvent`. */
export interface Span {
  id: string
  start: number
  end: number
  z: number
}

export const clipSpan = (c: Clip): Span => ({ id: c.id, start: c.start, end: c.start + c.dur, z: c.z })

/**
 * The span painted directly beneath `to` at the instant it begins — the "from"
 * side of `to`'s dissolve. The topmost (highest-z) other span covering `to.start`.
 */
export function fromSpan(spans: Span[], to: Span): Span | null {
  let best: Span | null = null
  for (const s of spans) {
    if (s.id === to.id) continue
    if (s.start <= to.start + EPS && s.end > to.start + EPS) {
      if (!best || s.z > best.z || (s.z === best.z && s.start > best.start)) best = s
    }
  }
  return best
}

/** The adjacent predecessor of `clip` on its own layer (its end meets clip.start).
 *  `track` may be a whole kind's clip list — other layers are skipped. */
export function precedingClip(track: Clip[], clip: Clip): Clip | null {
  let best: Clip | null = null
  for (const c of track) {
    if (c.id === clip.id || c.trackId !== clip.trackId) continue
    const end = c.start + c.dur
    if (c.start < clip.start - EPS && end >= clip.start - ADJ_TOL) {
      if (!best || end > best.start + best.dur) best = c
    }
  }
  return best
}

/** The active dissolve at time `t`, if the playhead is inside one. A dissolve is
 *  a same-layer construct, so the "from" lookup only sees the incoming clip's
 *  own track — `clips` may safely be a whole kind's list. */
export function transitionAt(
  clips: Clip[],
  t: number,
): { from: Clip; to: Clip; p: number } | null {
  for (const to of clips) {
    const d = to.transitionIn?.dur
    if (!d) continue
    if (t >= to.start && t < to.start + d) {
      const lane = clips.filter((c) => c.trackId === to.trackId)
      const fs = fromSpan(lane.map(clipSpan), clipSpan(to))
      const from = fs ? lane.find((c) => c.id === fs.id) : null
      if (from) return { from, to, p: (t - to.start) / d }
    }
  }
  return null
}

/**
 * Add a dissolve of `dur` seconds to `clipId`'s link group: slide the group and
 * everything after it left so the group overlaps its predecessor, and tag the
 * group's clips (those that actually have a predecessor) with `transitionIn`.
 * Returns fresh track arrays, or null when there's no adjacent predecessor / the
 * clamped length collapses to nothing. Pure — the caller commits + snapshots.
 */
export function rippleAddDissolve(
  video: Clip[],
  audio: Clip[],
  clipId: string,
  dur: number,
): { video: Clip[]; audio: Clip[]; groupIds: string[] } | null {
  const all = [...video, ...audio]
  const clip = all.find((c) => c.id === clipId)
  if (!clip) return null
  const bIds = new Set(all.filter((c) => c.link === clip.link).map((c) => c.id))
  const x = Math.min(...all.filter((c) => bIds.has(c.id)).map((c) => c.start))

  // Clamp the length to every involved clip and its predecessor; only clips that
  // have a predecessor get the tag (and constrain the length).
  const taggedIds = new Set<string>()
  let d = Math.min(dur, MAX_DISSOLVE_S)
  const consider = (track: Clip[]) => {
    for (const c of track) {
      if (!bIds.has(c.id)) continue
      const pred = precedingClip(track, c)
      if (pred) {
        taggedIds.add(c.id)
        d = Math.min(d, c.dur, pred.dur)
      }
    }
  }
  consider(video)
  consider(audio)
  if (!taggedIds.size || d <= EPS) return null

  const tag: Transition = { kind: 'dissolve', dur: d }
  const shift = (track: Clip[]) =>
    track.map((c) => {
      let nc = c
      if (c.start >= x - EPS) nc = { ...nc, start: nc.start - d }
      if (taggedIds.has(c.id)) nc = { ...nc, transitionIn: tag }
      return nc
    })
  return { video: shift(video), audio: shift(audio), groupIds: [...bIds] }
}

/** Reverse a dissolve on `clipId`'s group: clear the tag and slide the group and
 *  everything after it back to the right. Pure. */
export function rippleRemoveDissolve(
  video: Clip[],
  audio: Clip[],
  clipId: string,
): { video: Clip[]; audio: Clip[] } {
  const all = [...video, ...audio]
  const clip = all.find((c) => c.id === clipId)
  const d = clip?.transitionIn?.dur
  if (!clip || !d) return { video, audio }
  const bIds = new Set(all.filter((c) => c.link === clip.link).map((c) => c.id))
  const xp = Math.min(...all.filter((c) => bIds.has(c.id)).map((c) => c.start))

  const shift = (track: Clip[]) =>
    track.map((c) => {
      let nc = c
      if (bIds.has(c.id) && c.transitionIn) nc = { ...nc, transitionIn: undefined }
      if (c.start >= xp - EPS) nc = { ...nc, start: nc.start + d }
      return nc
    })
  return { video: shift(video), audio: shift(audio) }
}
