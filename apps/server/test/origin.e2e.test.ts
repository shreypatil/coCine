import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { presign, type OriginConfig } from '../src/origin.js'

/**
 * The authority on whether a hand-rolled SigV4 signature is correct is an S3
 * server, not another copy of the same arithmetic. MinIO is that server here; the
 * same URLs go to Cloudflare R2 unchanged, since R2 speaks the S3 API.
 *
 * A rejected signature returns 403 SignatureDoesNotMatch, so "the object was not
 * found" is already proof the signature verified.
 */

const CONTAINER = 'cocine-minio-e2e'
const PORT = 9123
const cfg: OriginConfig = {
  endpoint: `http://127.0.0.1:${PORT}`,
  bucket: 'cocine',
  accessKeyId: 'cocinetest',
  secretAccessKey: 'cocinetestsecret',
  region: 'us-east-1'
}

function hasDocker (): boolean {
  try { execFileSync('docker', ['info'], { stdio: 'ignore' }); return true } catch { return false }
}
const suite = hasDocker() ? describe : describe.skip

suite('presigned URLs against a real S3 implementation', () => {
  const body = Buffer.from('the film bytes '.repeat(1000))

  beforeAll(async () => {
    execFileSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' })
    execFileSync('docker', ['run', '-d', '--name', CONTAINER, '-p', `${PORT}:9000`,
      '-e', `MINIO_ROOT_USER=${cfg.accessKeyId}`, '-e', `MINIO_ROOT_PASSWORD=${cfg.secretAccessKey}`,
      'minio/minio:latest', 'server', '/data'], { stdio: 'ignore' })

    const deadline = Date.now() + 30000
    for (;;) {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/minio/health/live`)
        if (r.ok) break
      } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error('minio did not start')
      await new Promise(r => setTimeout(r, 250))
    }
    const mk = await fetch(presign(cfg, { method: 'PUT', key: '' }), { method: 'PUT' })
    expect(mk.status).toBe(200)
  }, 90000)

  afterAll(() => { execFileSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' }) })

  it('accepts a signed upload and returns the same bytes on a signed download', async () => {
    const put = await fetch(presign(cfg, { method: 'PUT', key: 'rooms/abc/film.mkv' }), { method: 'PUT', body })
    expect(put.status).toBe(200)

    const get = await fetch(presign(cfg, { method: 'GET', key: 'rooms/abc/film.mkv' }))
    expect(get.status).toBe(200)
    expect(Buffer.from(await get.arrayBuffer()).equals(body)).toBe(true)
  }, 30000)

  it('serves byte ranges, which is what lets a film play while it arrives', async () => {
    const res = await fetch(presign(cfg, { method: 'GET', key: 'rooms/abc/film.mkv' }),
      { headers: { Range: 'bytes=0-14' } })
    expect(res.status).toBe(206)
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('the film bytes ')
  }, 30000)

  it('rejects a URL whose key was edited after signing', async () => {
    const url = presign(cfg, { method: 'GET', key: 'rooms/abc/film.mkv' })
      .replace('rooms/abc/film.mkv', 'rooms/other/private.mkv')
    expect((await fetch(url)).status).toBe(403)
  }, 30000)

  it('rejects an expired URL', async () => {
    const url = presign(cfg, { method: 'GET', key: 'rooms/abc/film.mkv', expiresSeconds: 1, nowMs: Date.now() - 10_000 })
    expect((await fetch(url)).status).toBe(403)
  }, 30000)

  it('will not let a download URL upload', async () => {
    const res = await fetch(presign(cfg, { method: 'GET', key: 'rooms/abc/film.mkv' }),
      { method: 'PUT', body: Buffer.from('overwritten') })
    expect(res.status).toBe(403)
  }, 30000)
})
