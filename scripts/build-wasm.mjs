// Builds every Rust crate in `crates/` to WebAssembly with wasm-pack and drops
// the generated glue + `.wasm` into `src/wasm/pkg/<crate>` so Vite can bundle it.
//
//   node scripts/build-wasm.mjs              # (re)build all crates
//   node scripts/build-wasm.mjs --if-missing # skip crates already built
//
// Run automatically before `dev`/`build` (see package.json), or on demand with
// `npm run wasm`.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ifMissing = process.argv.includes('--if-missing')

// Crates with a wasm-bindgen surface that are shipped to the frontend.
const crates = ['waz-stinger-wasm', 'waz-wave-wasm', 'waz-strip-wasm', 'waz-edl-wasm']

for (const crate of crates) {
  const outDir = resolve(root, 'src/wasm/pkg', crate)
  const glue = resolve(outDir, `${crate.replace(/-/g, '_')}.js`)

  if (ifMissing && existsSync(glue)) {
    console.log(`✓ ${crate} — already built, skipping`)
    continue
  }

  console.log(`▸ building ${crate} …`)
  execFileSync(
    'wasm-pack',
    ['build', `crates/${crate}`, '--target', 'web', '--out-dir', outDir, '--out-name', crate.replace(/-/g, '_')],
    { cwd: root, stdio: 'inherit' },
  )
}

console.log('✓ wasm build complete')
