/** Monotonic, session-unique id generator (`c1`, `c2`, …). */

let counter = 0

export const uid = (): string => 'c' + ++counter

/** Monotonic z-order counter — new clips paint above older ones by default. */
let zCounter = 0

export const nextZ = (): number => ++zCounter

/**
 * Bump the id / z counters past a set of existing values. MUST be called when a
 * persisted session is restored: both counters reset to 0 on reload while the
 * restored sources/clips keep their old `c<n>` ids, so without re-seeding the
 * next uid() would collide with a restored id (duplicate React keys, two clips
 * moving as one — clips visibly "vanish").
 */
export function seedIds(ids: Iterable<string>, zs: Iterable<number> = []): void {
  for (const id of ids) {
    const m = /^c(\d+)$/.exec(id)
    if (m) counter = Math.max(counter, parseInt(m[1], 10))
  }
  for (const z of zs) {
    if (Number.isFinite(z)) zCounter = Math.max(zCounter, Math.ceil(z))
  }
}
