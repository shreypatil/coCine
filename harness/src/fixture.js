// Deterministic incompressible test file, cached between runs.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, statSync, createWriteStream } from 'node:fs'
import { join } from 'node:path'

export async function ensureFixture (fileMB, dir) {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `movie-${fileMB}MB.bin`)
  const bytes = fileMB * 1024 * 1024
  if (existsSync(path) && statSync(path).size === bytes) return path

  // xorshift-seeded blocks: incompressible, reproducible, fast to generate.
  const out = createWriteStream(path)
  const block = Buffer.allocUnsafe(1024 * 1024)
  let seed = 0x9e3779b9
  for (let m = 0; m < fileMB; m++) {
    for (let i = 0; i < block.length; i += 4) {
      seed ^= seed << 13; seed >>>= 0
      seed ^= seed >>> 17
      seed ^= seed << 5; seed >>>= 0
      block.writeUInt32LE(seed, i)
    }
    if (!out.write(Buffer.from(block))) {
      await new Promise(res => out.once('drain', res))
    }
  }
  await new Promise(res => out.end(res))
  return path
}

export function shortHash (obj) {
  return createHash('sha1').update(JSON.stringify(obj)).digest('hex').slice(0, 8)
}
