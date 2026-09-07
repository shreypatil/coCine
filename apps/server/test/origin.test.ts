import { describe, it, expect } from 'vitest'
import { presign, objectKeyFor, type OriginConfig } from '../src/origin.js'

/**
 * Signature Version 4 is hand-rolled in origin.ts, so it has to be shown to agree
 * with a real S3 implementation rather than merely with itself. That check lives
 * in origin.e2e.test.ts, which signs against MinIO and watches it accept or
 * reject. What follows is the structural half: the parts of the URL that must be
 * right for that to have a chance, and the properties the signature must have.
 */
const S3_STYLE: OriginConfig = {
  endpoint: 'https://s3.amazonaws.com',
  bucket: 'examplebucket',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  pathStyle: false
}
/** Fixed so signatures are comparable between calls. */
const FIXED_TIME = Date.UTC(2013, 4, 24, 0, 0, 0)

describe('SigV4 presigning', () => {
  it('builds virtual-hosted style URLs the way S3 documents them', () => {
    const url = new URL(presign(S3_STYLE, {
      method: 'GET', key: 'test.txt', expiresSeconds: 86400, nowMs: FIXED_TIME
    }))
    expect(url.host).toBe('examplebucket.s3.amazonaws.com')
    expect(url.pathname).toBe('/test.txt')
    expect(url.searchParams.get('X-Amz-Credential')).toBe('AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request')
    expect(url.searchParams.get('X-Amz-Date')).toBe('20130524T000000Z')
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host')
  })

  const r2: OriginConfig = {
    endpoint: 'https://acct123.r2.cloudflarestorage.com',
    bucket: 'cocine',
    accessKeyId: 'key',
    secretAccessKey: 'secret'
  }

  it('puts the bucket in the path for R2 rather than the hostname', () => {
    const url = new URL(presign(r2, { method: 'PUT', key: 'rooms/abc/film.mkv' }))
    expect(url.host).toBe('acct123.r2.cloudflarestorage.com')
    expect(url.pathname).toBe('/cocine/rooms/abc/film.mkv')
  })

  it('signs the method, so an upload URL cannot be used to download', () => {
    const put = presign(r2, { method: 'PUT', key: 'k', nowMs: FIXED_TIME })
    const get = presign(r2, { method: 'GET', key: 'k', nowMs: FIXED_TIME })
    const sig = (u: string) => new URL(u).searchParams.get('X-Amz-Signature')
    expect(sig(put)).not.toBe(sig(get))
  })

  it('signs the key, so a URL for one film cannot fetch another', () => {
    const a = presign(r2, { method: 'GET', key: 'rooms/abc/one.mkv', nowMs: FIXED_TIME })
    const b = presign(r2, { method: 'GET', key: 'rooms/abc/two.mkv', nowMs: FIXED_TIME })
    const sig = (u: string) => new URL(u).searchParams.get('X-Amz-Signature')
    expect(sig(a)).not.toBe(sig(b))
  })

  it('addresses the bucket itself when the key is empty, with no trailing slash', () => {
    // `/bucket/` and `/bucket` are different canonical URIs; signing one and
    // requesting the other is rejected.
    expect(new URL(presign(r2, { method: 'PUT', key: '' })).pathname).toBe('/cocine')
  })

  it('carries the expiry the caller asked for', () => {
    const url = new URL(presign(r2, { method: 'GET', key: 'k', expiresSeconds: 900 }))
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900')
  })

  it('never puts the secret key in the URL', () => {
    const url = presign(r2, { method: 'PUT', key: 'k' })
    expect(url).not.toContain('secret')
  })

  it('encodes spaces and unicode in a key without breaking the signature', () => {
    // encodeURIComponent and AWS's canonical encoding differ; a mismatch here
    // signs fine locally and is rejected by the service.
    const url = new URL(presign(r2, { method: 'GET', key: 'rooms/abc/a film (2019).mkv' }))
    expect(url.pathname).toBe('/cocine/rooms/abc/a%20film%20%282019%29.mkv')
  })
})

describe('object keys', () => {
  it('scopes a film to its room, so one room cannot name another\'s object', () => {
    expect(objectKeyFor('W8FBZTG9', 'abc123', 'film.mkv')).toBe('rooms/w8fbztg9/abc123/film.mkv')
  })

  it('strips characters that would change the path shape', () => {
    const key = objectKeyFor('ROOM', 'id', '../../etc/passwd')
    expect(key).toBe('rooms/room/id/.._.._etc_passwd')
    expect(key.split('/')).toHaveLength(4)
  })

  it('keeps the same key for the same content, so re-sharing does not re-upload', () => {
    expect(objectKeyFor('R', 'hash1', 'f.mkv')).toBe(objectKeyFor('R', 'hash1', 'f.mkv'))
  })
})
