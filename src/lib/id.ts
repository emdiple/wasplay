/** Monotonic, session-unique id generator (`c1`, `c2`, …). */

let counter = 0

export const uid = (): string => 'c' + ++counter

/** Monotonic z-order counter — new clips paint above older ones by default. */
let zCounter = 0

export const nextZ = (): number => ++zCounter
