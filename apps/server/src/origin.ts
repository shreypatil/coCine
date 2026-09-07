import { createHmac, createHash } from 'node:crypto'

/**
 * Presigned URLs for the origin transport (phase 7).
 *
 * Relay mode exists for the room where peer-to-peer cannot deliver: the sharer
 * uploads once and everyone fetches from an origin. Cloudflare R2 is the
 * intended target because it charges nothing for egress, where S3 at $0.09/GB
 * makes each movie night cost real money. R2 speaks the S3 API, so this works
 * against R2, MinIO or S3 without changes.
 *
 * **Clients never hold the bucket credentials.** The server signs a URL scoped to
 * one method, one key and a short expiry, and hands that over instead -- the same
 * shape as the TURN credentials in turn.ts, and for the same reason: a long-lived
 * secret distributed to every participant is a secret that leaks.
 *
 * Signature Version 4 is implemented here rather than pulled in with the AWS SDK,
 * which would add a large dependency tree for one function. It is checked against
 * AWS's own published test vector in the tests.
 */

export interface OriginConfig {
  /** e.g. https://<account>.r2.cloudflarestorage.com — no bucket, no trailing slash. */
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  /** R2 ignores the region but still requires it in the signature; 'auto' is its convention. */
  region?: string
  /**
   * Path-style puts the bucket in the path (endpoint/bucket/key), which is what
   * R2 and MinIO use. Virtual-hosted style puts it in the hostname, which is what
   * S3 documents. Default path-style.
   */
  pathStyle?: boolean
}

const ALGORITHM = 'AWS4-HMAC-SHA256'
const SERVICE = 's3'

/** Default lifetime of a signed URL. Long enough to upload several gigabytes on
 *  a slow uplink, short enough that a leaked URL stops working the same day. */
export const DEFAULT_EXPIRY_SECONDS = 6 * 3600

const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac('sha256', key).update(data, 'utf8').digest()

const sha256Hex = (data: string): string =>
  createHash('sha256').update(data, 'utf8').digest('hex')

/**
 * Percent-encode for a canonical URI. Not encodeURIComponent: AWS requires the
 * unreserved set to stay literal and everything else encoded, and differs from
 * encodeURIComponent on `!*'()`. Getting this wrong produces a signature that
 * verifies locally and is rejected by the service.
 */
function uriEncode (str: string, encodeSlash: boolean): string {
  let out = ''
  for (const ch of Buffer.from(str, 'utf8')) {
    const c = String.fromCharCode(ch)
    if ((ch >= 0x41 && ch <= 0x5a) || (ch >= 0x61 && ch <= 0x7a) ||
        (ch >= 0x30 && ch <= 0x39) || c === '-' || c === '.' || c === '_' || c === '~') {
      out += c
    } else if (c === '/') {
      out += encodeSlash ? '%2F' : '/'
    } else {
      out += '%' + ch.toString(16).toUpperCase().padStart(2, '0')
    }
  }
  return out
}

/** The signing key is derived per day, per region, per service -- which is what
 *  limits the blast radius of one leaking. */
function signingKey (secret: string, date: string, region: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), SERVICE), 'aws4_request')
}

export interface PresignOptions {
  method: 'GET' | 'PUT' | 'HEAD' | 'DELETE'
  key: string
  expiresSeconds?: number
  /** Overridable so tests can reproduce AWS's published vector exactly. */
  nowMs?: number
}

/**
 * A URL that carries its own authorisation. Anyone holding it can perform
 * exactly this method on exactly this key until it expires, and nothing else.
 */
export function presign (cfg: OriginConfig, opts: PresignOptions): string {
  const region = cfg.region ?? 'auto'
  const pathStyle = cfg.pathStyle ?? true
  const expires = opts.expiresSeconds ?? DEFAULT_EXPIRY_SECONDS

  const url = new URL(cfg.endpoint)
  const host = pathStyle ? url.host : `${cfg.bucket}.${url.host}`
  const basePath = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')
  // An empty key addresses the bucket itself, which is how a bucket is created
  // or listed. The trailing slash matters: `/bucket/` is a different canonical
  // URI from `/bucket`, and signing one while requesting the other fails.
  const encodedKey = opts.key === '' ? '' : `/${uriEncode(opts.key, false)}`
  const canonicalUri = pathStyle
    ? `${basePath}/${uriEncode(cfg.bucket, true)}${encodedKey}`
    : `${basePath}${encodedKey === '' ? '/' : encodedKey}`

  const now = new Date(opts.nowMs ?? Date.now())
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const dateStamp = amzDate.slice(0, 8)
  const scope = `${dateStamp}/${region}/${SERVICE}/aws4_request`

  // Query parameters must be sorted by name for the canonical request, and the
  // signature itself is appended afterwards rather than signed.
  const params: Array<[string, string]> = [
    ['X-Amz-Algorithm', ALGORITHM],
    ['X-Amz-Credential', `${cfg.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expires)],
    ['X-Amz-SignedHeaders', 'host']
  ]
  params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const canonicalQuery = params.map(([k, v]) => `${uriEncode(k, true)}=${uriEncode(v, true)}`).join('&')

  const canonicalRequest = [
    opts.method,
    canonicalUri,
    canonicalQuery,
    `host:${host}\n`,
    'host',
    // The body is not signed: it is streamed, and its hash is not known when the
    // URL is minted. This is the documented behaviour for presigned URLs.
    'UNSIGNED-PAYLOAD'
  ].join('\n')

  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n')
  const signature = hmac(signingKey(cfg.secretAccessKey, dateStamp, region), stringToSign).toString('hex')

  return `${url.protocol}//${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`
}

/**
 * Where a room's film lives in the bucket. Scoped by room so one room can never
 * name another's object, and suffixed with the content hash so re-sharing the
 * same film twice does not upload it twice.
 */
export function objectKeyFor (roomCode: string, contentId: string, name: string): string {
  const safeName = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(-80)
  return `rooms/${roomCode.toLowerCase()}/${contentId}/${safeName}`
}
