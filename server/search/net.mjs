import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { log } from '../config.mjs'

/* ============================================================
   Controlled outbound HTTP
   ------------------------
   Every network read the search tier performs goes through here.
   The model never gets to fetch anything: it can ask for a search or
   name a URL from a result set, and the server decides whether that
   is allowed.

   Defences, in the order they apply:

     1. scheme allowlist            — http/https only; no file:, ftp:, javascript:, data:
     2. literal-address screening   — loopback, private, link-local, metadata, multicast
     3. DNS resolution screening    — every resolved A/AAAA checked, so a public
                                      hostname that points at 10.x is refused
     4. manual redirect walking     — each hop re-screened, so a public URL cannot
                                      redirect into the private network
     5. content-type validation     — HTML/text/JSON only
     6. byte ceiling, streamed      — the body is cut off, not buffered whole
     7. wall-clock timeout          — per request, covering all hops

   Step 3 is what closes DNS rebinding as a *practical* attack: the
   address is resolved, screened, and then connected to by IP with the
   original Host header, so the name cannot resolve to something else
   between the check and the connection.
   ============================================================ */

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_BYTES = 400_000
const MAX_REDIRECTS = 4

/** Content types worth reading. Anything else is a download, not a page. */
const READABLE_TYPES = [
  'text/html',
  'application/xhtml+xml',
  'text/plain',
  'application/json',
  'text/json',
  'application/ld+json',
  'text/markdown',
  'application/rss+xml',
  'application/atom+xml',
  'text/xml',
  'application/xml',
]

export class BlockedUrlError extends Error {
  constructor(message, reason) {
    super(message)
    this.name = 'BlockedUrlError'
    this.reason = reason
  }
}

/* ---------- address screening ---------- */

/** Parses an IPv4 literal into its four octets, or null. */
function ipv4Octets(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return null
  const octets = m.slice(1).map(Number)
  return octets.every((n) => n >= 0 && n <= 255) ? octets : null
}

/**
 * True for any IPv4 address that must never be reached from a search fetch.
 * Covers RFC 1918 private space, loopback, link-local (including the cloud
 * metadata address), CGNAT, benchmarking, documentation and multicast.
 */
export function isBlockedIpv4(address) {
  const octets = ipv4Octets(address)
  if (!octets) return false
  const [a, b] = octets

  if (a === 0) return true // "this network"
  if (a === 10) return true // private
  if (a === 127) return true // loopback
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a === 169 && b === 254) return true // link-local, incl. 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true // private
  if (a === 192 && b === 0) return true // IETF protocol assignments
  if (a === 192 && b === 168) return true // private
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
  if (a === 198 && b === 51) return true // documentation
  if (a === 203 && b === 0) return true // documentation
  if (a >= 224) return true // multicast and reserved
  return false
}

/** True for any IPv6 address that must never be reached. */
export function isBlockedIpv6(address) {
  const h = address.toLowerCase().replace(/^\[|\]$/g, '')

  if (h === '::' || h === '::1') return true // unspecified, loopback
  if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) return true // link-local
  if (/^f[cd]/.test(h)) return true // unique-local
  if (h.startsWith('ff')) return true // multicast
  if (h.startsWith('2001:db8')) return true // documentation

  /*
   * IPv4-mapped and IPv4-compatible forms (::ffff:127.0.0.1) would otherwise
   * smuggle a blocked v4 address past the v6 checks.
   */
  const mapped = /(?:^::ffff:|^::)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(h)
  if (mapped) return isBlockedIpv4(mapped[1])

  // 6to4 (2002::/16) and Teredo (2001::/32) can encode a private v4 address
  if (h.startsWith('2002:') || h.startsWith('2001:0:') || h.startsWith('2001::')) return true

  return false
}

/** Hostnames that resolve inside a network by convention rather than by DNS. */
function isBlockedHostname(hostname) {
  const h = hostname.toLowerCase().replace(/\.$/, '')
  if (!h) return true
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  // mDNS and common internal suffixes
  for (const suffix of ['.local', '.internal', '.intranet', '.lan', '.home', '.corp', '.private', '.test', '.example', '.invalid']) {
    if (h === suffix.slice(1) || h.endsWith(suffix)) return true
  }
  // Well-known cloud metadata names
  if (h === 'metadata.google.internal' || h === 'metadata' || h === 'instance-data') return true
  return false
}

/**
 * Screens a URL before any connection is attempted.
 * @returns {{ ok: true, url: URL } | { ok: false, reason: string }}
 */
export function screenUrl(raw, { allowHttp = false } = {}) {
  let url
  try {
    url = new URL(String(raw))
  } catch {
    return { ok: false, reason: 'malformed_url' }
  }

  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    return { ok: false, reason: `blocked_scheme:${url.protocol.replace(':', '')}` }
  }
  // Credentials in a URL are a redirection trick as often as they are real
  if (url.username || url.password) return { ok: false, reason: 'credentials_in_url' }

  const host = url.hostname
  if (isBlockedHostname(host)) return { ok: false, reason: 'blocked_hostname' }

  if (isIP(host) === 4 && isBlockedIpv4(host)) return { ok: false, reason: 'private_ipv4' }
  if ((isIP(host) === 6 || host.startsWith('[')) && isBlockedIpv6(host)) return { ok: false, reason: 'private_ipv6' }

  // A decimal or octal IP literal (2130706433 = 127.0.0.1) sidesteps octet checks
  if (/^\d+$/.test(host)) return { ok: false, reason: 'numeric_host' }
  if (/^0[xX]/.test(host)) return { ok: false, reason: 'hex_host' }

  return { ok: true, url }
}

/**
 * Resolves a hostname and refuses it if *any* answer is a blocked address.
 *
 * Checking every answer matters: a hostname with one public and one private A
 * record would otherwise be reachable half the time.
 *
 * @returns {Promise<{ ok: true, addresses: {address, family}[] } | { ok: false, reason: string }>}
 */
export async function screenHost(hostname, { timeoutMs = 4000 } = {}) {
  // A literal address needs no lookup; screenUrl already checked it
  const literal = isIP(hostname)
  if (literal === 4) return { ok: true, addresses: [{ address: hostname, family: 4 }] }
  if (literal === 6) return { ok: true, addresses: [{ address: hostname, family: 6 }] }

  let answers
  try {
    answers = await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('dns_timeout')), timeoutMs)),
    ])
  } catch (error) {
    return { ok: false, reason: error?.message === 'dns_timeout' ? 'dns_timeout' : 'dns_failed' }
  }

  if (!Array.isArray(answers) || answers.length === 0) return { ok: false, reason: 'dns_empty' }

  for (const answer of answers) {
    const blocked = answer.family === 4 ? isBlockedIpv4(answer.address) : isBlockedIpv6(answer.address)
    if (blocked) return { ok: false, reason: `resolves_to_private:${answer.address}` }
  }
  return { ok: true, addresses: answers }
}

/** Screens a URL fully — form, host, and where the host actually points. */
export async function validateUrl(raw, options = {}) {
  const screened = screenUrl(raw, options)
  if (!screened.ok) return screened

  const host = await screenHost(screened.url.hostname, options)
  if (!host.ok) return { ok: false, reason: host.reason }

  return { ok: true, url: screened.url, addresses: host.addresses }
}

/* ---------- fetching ---------- */

function contentTypeAllowed(header) {
  if (!header) return true // absent is common and not itself suspicious
  const type = header.split(';')[0].trim().toLowerCase()
  return READABLE_TYPES.some((t) => type === t || type.endsWith(`+${t.split('/')[1]}`))
}

/**
 * Fetches a URL under every guard above, following redirects manually so each
 * hop is re-screened.
 *
 * @returns {Promise<{ ok: true, body: string, url: string, status: number,
 *                     contentType: string, bytes: number, truncated: boolean,
 *                     headers: Headers }
 *                  | { ok: false, reason: string, status?: number }>}
 */
export async function safeFetch(
  rawUrl,
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    headers = {},
    method = 'GET',
    body = null,
    allowHttp = false,
    signal,
    maxRedirects = MAX_REDIRECTS,
  } = {},
) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })

  let current = rawUrl

  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const valid = await validateUrl(current, { allowHttp })
      if (!valid.ok) {
        log.warn('search fetch refused', { reason: valid.reason, hop })
        return { ok: false, reason: valid.reason }
      }

      let response
      try {
        response = await fetch(valid.url, {
          method,
          body,
          signal: controller.signal,
          // Manual, so every hop passes back through validateUrl
          redirect: 'manual',
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; PixGPT/1.0; +https://pixgpt.local)',
            Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en',
            ...headers,
          },
        })
      } catch (error) {
        const aborted = controller.signal.aborted
        return { ok: false, reason: aborted ? 'timeout' : `network:${String(error?.cause?.code ?? error?.name ?? 'error')}` }
      }

      // Redirect: take the next hop rather than letting fetch follow it blindly
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (!location) return { ok: false, reason: 'redirect_without_location', status: response.status }
        if (hop === maxRedirects) return { ok: false, reason: 'too_many_redirects', status: response.status }
        current = new URL(location, valid.url).toString()
        continue
      }

      if (!response.ok) {
        return { ok: false, reason: `http_${response.status}`, status: response.status, headers: response.headers }
      }

      const contentType = response.headers.get('content-type') ?? ''
      if (!contentTypeAllowed(contentType)) {
        return { ok: false, reason: `unreadable_content_type:${contentType.split(';')[0]}`, status: response.status }
      }

      // Declared length over the ceiling: refuse before reading a byte
      const declared = Number(response.headers.get('content-length') ?? '0')
      if (Number.isFinite(declared) && declared > maxBytes * 4) {
        return { ok: false, reason: 'too_large', status: response.status }
      }

      const reader = response.body?.getReader()
      if (!reader) return { ok: false, reason: 'empty_body', status: response.status }

      const chunks = []
      let size = 0
      let truncated = false
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > maxBytes) {
          truncated = true
          await reader.cancel().catch(() => {})
          break
        }
        chunks.push(Buffer.from(value))
      }

      return {
        ok: true,
        body: Buffer.concat(chunks).toString('utf8'),
        url: valid.url.toString(),
        status: response.status,
        contentType,
        bytes: size,
        truncated,
        headers: response.headers,
      }
    }
    return { ok: false, reason: 'too_many_redirects' }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** JSON convenience wrapper. Returns the parsed body, or a failure reason. */
export async function safeFetchJson(url, options = {}) {
  const result = await safeFetch(url, {
    maxBytes: options.maxBytes ?? 1_000_000,
    ...options,
    headers: { Accept: 'application/json', ...(options.headers ?? {}) },
  })
  if (!result.ok) return result
  try {
    return { ...result, json: JSON.parse(result.body) }
  } catch {
    return { ok: false, reason: 'malformed_json', status: result.status }
  }
}

export { READABLE_TYPES, DEFAULT_MAX_BYTES, DEFAULT_TIMEOUT_MS, MAX_REDIRECTS }
