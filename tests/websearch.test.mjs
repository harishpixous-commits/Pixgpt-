import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { renderSearchContext, searchAvailable, searchStatus } from '../server/websearch.mjs'
import { listProviders, selectProviders, availableTypes } from '../server/search/registry.mjs'
import { screenUrl, isBlockedIpv4, isBlockedIpv6, validateUrl, safeFetch } from '../server/search/net.mjs'
import { classify, planQueries, coreTerms } from '../server/search/intent.mjs'
import { isTimeSensitive, ttlFor, clear as clearCache, stats as cacheStats } from '../server/search/cache.mjs'
import { mergeResults, rankScore } from '../server/search/orchestrator.mjs'
import { compareSources } from '../server/search/research.mjs'
import { htmlToText, decodeEntities, toPassages } from '../server/search/extract.mjs'
import { makeResult, dedupeKey, normaliseDate, domainOf, SEARCH_TYPE } from '../server/search/types.mjs'
import {
  noteFailure,
  noteSuccess,
  noteRetryAfter,
  healthOf,
  isOpen,
  resetHealth,
  classifyFailure,
} from '../server/search/health.mjs'
import { classifyVisionFailure, visionCandidates, resetVisionRoutes } from '../server/vision-router.mjs'

/* ============================================================
   Web search and research.

   Configuration, provider routing, SSRF policy, ranking, caching,
   health/circuit-breaking and context framing. Nothing here touches the
   network except where a test says so explicitly — live retrieval is
   verified separately and recorded in the docs.
   ============================================================ */

/** Sets environment variables for one test and restores them afterwards. */
function withEnv(vars, fn) {
  const saved = {}
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return fn()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

describe('provider registry', () => {
  test('every provider declares what it is and what it can do', () => {
    for (const provider of listProviders()) {
      assert.ok(provider.id, 'a provider needs an id')
      assert.ok(provider.name, `${provider.id} needs a name`)
      assert.ok(provider.cost, `${provider.id} needs a cost class`)
      assert.ok(Array.isArray(provider.capabilities.types), `${provider.id} needs declared types`)
      assert.equal(typeof provider.configured, 'boolean')
      assert.equal(typeof provider.available, 'boolean')
      assert.ok(provider.health.state, `${provider.id} needs a health state`)
    }
  })

  test('a provider is never advertised for a type it cannot serve', () => {
    for (const type of Object.values(SEARCH_TYPE)) {
      for (const chosen of selectProviders({ type, includeUnhealthy: true })) {
        assert.ok(
          chosen.descriptor.types.includes(type),
          `${chosen.id} was selected for ${type} but does not declare it`,
        )
      }
    }
  })

  test('an unconfigured provider names its variable and never a secret', () => {
    for (const provider of listProviders()) {
      if (!provider.configured) assert.ok(provider.requires, `${provider.id} should say what it needs`)
    }
    const serialised = JSON.stringify(listProviders())
    assert.ok(!/apiKey|api_key/.test(serialised), 'the registry must not expose credentials')
  })

  test('keyless providers are usable with no configuration at all', () => {
    for (const id of ['duckduckgo', 'wikipedia', 'github']) {
      const provider = listProviders().find((p) => p.id === id)
      assert.equal(provider.configured, true, `${id} needs no key and should be configured`)
    }
  })

  test('a keyed provider becomes configured once its key is present', () => {
    withEnv({ TAVILY_API_KEY: undefined }, () => {
      assert.equal(listProviders().find((p) => p.id === 'tavily').configured, false)
    })
    withEnv({ TAVILY_API_KEY: 'test-key-not-real' }, () => {
      const tavily = listProviders().find((p) => p.id === 'tavily')
      assert.equal(tavily.configured, true)
      assert.equal(tavily.requires, null)
    })
  })

  test('free-first: self-hosted outranks a metered provider', () => {
    withEnv(
      {
        SEARXNG_URL: 'https://searx.example.test',
        TAVILY_API_KEY: 'k',
        BRAVE_SEARCH_API_KEY: 'k',
        SEARCH_PROVIDER_PRIMARY: undefined,
        SEARCH_PROVIDER_ORDER: undefined,
      },
      () => {
        const order = selectProviders({ type: SEARCH_TYPE.WEB, limit: 6 }).map((p) => p.id)
        assert.equal(order[0], 'searxng', `self-hosted should lead, got ${order.join(' > ')}`)
        assert.ok(order.indexOf('searxng') < order.indexOf('tavily'), 'credits must not be spent first')
      },
    )
  })

  test('free-only mode excludes every metered provider', () => {
    withEnv({ TAVILY_API_KEY: 'k', BRAVE_SEARCH_API_KEY: 'k', SERPER_API_KEY: 'k', EXA_API_KEY: 'k' }, () => {
      const chosen = selectProviders({ type: SEARCH_TYPE.WEB, freeOnly: true, limit: 9 }).map((p) => p.id)
      for (const metered of ['tavily', 'brave', 'serper', 'exa']) {
        assert.ok(!chosen.includes(metered), `${metered} costs credits and must be excluded`)
      }
    })
  })

  test('explicit configuration overrides the cost-based default', () => {
    withEnv({ TAVILY_API_KEY: 'k', SEARCH_PROVIDER_PRIMARY: 'tavily' }, () => {
      const order = selectProviders({ type: SEARCH_TYPE.WEB, limit: 6 }).map((p) => p.id)
      assert.equal(order[0], 'tavily', `an explicit primary must lead, got ${order.join(' > ')}`)
    })
  })

  test('a specialist does not lead a search outside its strengths', () => {
    const web = selectProviders({ type: SEARCH_TYPE.WEB, limit: 5 }).map((p) => p.id)
    const reference = selectProviders({ type: SEARCH_TYPE.REFERENCE, limit: 5 }).map((p) => p.id)
    if (web.includes('wikipedia') && web.length > 1) {
      assert.notEqual(web[0], 'wikipedia', `a reference specialist should not lead web: ${web.join(' > ')}`)
    }
    assert.equal(reference[0], 'wikipedia', `wikipedia should lead reference, got ${reference.join(' > ')}`)
  })

  test('search reports available when a keyless provider exists', () => {
    assert.equal(searchAvailable(), true)
    const status = searchStatus()
    assert.equal(status.available, true)
    assert.ok(Array.isArray(status.providers))
    assert.ok(!JSON.stringify(status).includes('apiKey'))
  })

  test('"none" disables search entirely', () => {
    withEnv({ WEB_SEARCH_PROVIDER: 'none' }, () => {
      assert.equal(searchAvailable(), false)
      assert.deepEqual(searchStatus(), { available: false, provider: 'none', reason: 'disabled' })
    })
  })

  test('only types a configured provider supports are advertised', () => {
    withEnv({ SERPER_API_KEY: undefined }, () => {
      assert.ok(!availableTypes().includes(SEARCH_TYPE.IMAGES), 'images needs a provider that does images')
    })
    assert.ok(availableTypes().includes(SEARCH_TYPE.WEB))
  })
})

describe('context framing', () => {
  const context = '[1] Example\nURL: https://example.com\nSome retrieved text.'

  test('fences results and labels them as data, not instructions', () => {
    const out = renderSearchContext('who is the CM', context, new Date('2026-08-14T00:00:00Z'))
    assert.ok(out.includes('BEGIN WEB SEARCH RESULTS'))
    assert.ok(out.includes('END WEB SEARCH RESULTS'))
    assert.ok(/not instructions/i.test(out), 'retrieved pages are attacker-influenced content')
  })

  test('states the current date so the model prefers results over memory', () => {
    const out = renderSearchContext('q', context, new Date('2026-08-14T00:00:00Z'))
    assert.ok(out.includes('2026-08-14'))
    assert.ok(/current than your training/i.test(out.replace(/\s+/g, ' ')))
  })

  test('tells the model to admit when results do not answer the question', () => {
    assert.ok(/rather than guessing/i.test(renderSearchContext('q', context)))
  })

  test('includes the query so the model knows what was searched', () => {
    assert.ok(renderSearchContext('tamil nadu chief minister', context).includes('tamil nadu chief minister'))
  })
})

describe('SSRF policy', () => {
  test('only http(s) is ever fetched', () => {
    for (const url of ['file:///etc/passwd', 'ftp://x.test/a', 'javascript:alert(1)', 'data:text/html,x']) {
      const result = screenUrl(url)
      assert.equal(result.ok, false, `${url} must be refused`)
      assert.match(result.reason, /scheme/, `${url} should be refused for its scheme`)
    }
    assert.equal(screenUrl('https://example.com/').ok, true)
    // Plain http only for a caller that explicitly opts in, for a self-hosted service
    assert.equal(screenUrl('http://example.com/').ok, false)
    assert.equal(screenUrl('http://example.com/', { allowHttp: true }).ok, true)
  })

  test('loopback, private, link-local and metadata hosts are refused', () => {
    for (const url of [
      'https://localhost/x',
      'https://127.0.0.1/x',
      'https://10.0.0.1/x',
      'https://172.16.0.1/x',
      'https://192.168.1.1/x',
      'https://169.254.169.254/latest/meta-data/',
      'https://100.64.0.1/x',
      'https://0.0.0.0/x',
      'https://[::1]/x',
      'https://metadata.google.internal/x',
      'https://thing.internal/x',
      'https://box.local/x',
    ]) {
      assert.equal(screenUrl(url).ok, false, `${url} must be refused`)
    }
  })

  test('numeric and hex host encodings cannot smuggle a private address', () => {
    // 2130706433 === 127.0.0.1
    assert.equal(screenUrl('https://2130706433/x').ok, false)
    assert.equal(screenUrl('https://0x7f000001/x').ok, false)
  })

  test('credentials in a URL are refused', () => {
    assert.equal(screenUrl('https://user:pass@example.com/').ok, false)
  })

  test('IPv4-mapped IPv6 cannot bypass the IPv4 rules', () => {
    assert.equal(isBlockedIpv6('::ffff:127.0.0.1'), true)
    assert.equal(isBlockedIpv6('::ffff:10.0.0.1'), true)
    assert.equal(isBlockedIpv6('fd00::1'), true, 'unique-local')
    assert.equal(isBlockedIpv6('fe80::1'), true, 'link-local')
    assert.equal(isBlockedIpv6('2606:4700::1111'), false, 'a public address must be allowed')
  })

  test('the full IPv4 private space is covered', () => {
    for (const address of [
      '0.1.2.3',
      '10.1.2.3',
      '127.0.0.1',
      '169.254.1.1',
      '172.20.1.1',
      '192.168.0.1',
      '100.100.1.1',
      '198.18.0.1',
      '224.0.0.1',
    ]) {
      assert.equal(isBlockedIpv4(address), true, `${address} must be blocked`)
    }
    for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1']) {
      assert.equal(isBlockedIpv4(address), false, `${address} is public and must be allowed`)
    }
  })

  test('a hostname resolving to a private address is refused', async () => {
    // A public *name* pointing at 127.0.0.1 is what the DNS screen exists for
    const result = await validateUrl('https://localtest.me/')
    assert.equal(result.ok, false)
    assert.match(result.reason, /resolves_to_private|dns_/, `expected a DNS refusal, got ${result.reason}`)
  })

  test('a refused URL never reaches the network', async () => {
    const result = await safeFetch('https://169.254.169.254/latest/meta-data/')
    assert.equal(result.ok, false)
    assert.ok(!('status' in result), 'nothing should have been sent')
  })

  test('malformed URLs are refused, not guessed at', () => {
    for (const url of ['', 'not a url', 'http://', '://x', null, undefined]) {
      assert.equal(screenUrl(url).ok, false, `${JSON.stringify(url)} must be refused`)
    }
  })
})

describe('intent classification', () => {
  test('a live question is recognised as time-sensitive', () => {
    for (const query of ['what is the latest React version', 'news today', 'current bitcoin price', 'breaking news']) {
      assert.equal(classify(query).timeSensitive, true, `${query} is about the present`)
    }
    assert.equal(classify('what is photosynthesis').timeSensitive, false)
  })

  test('a named package routes to documentation, not reference', () => {
    // Opens like an encyclopedia question; answered by the project's release notes
    assert.equal(classify('What is the latest stable version of React?').type, SEARCH_TYPE.DOCUMENTATION)
    assert.equal(classify('What is photosynthesis?').type, SEARCH_TYPE.REFERENCE)
  })

  test('GitHub and news questions route to their own types', () => {
    assert.equal(classify('find a rate limiter implementation on GitHub').type, SEARCH_TYPE.GITHUB)
    assert.equal(classify('what happened in the news today').type, SEARCH_TYPE.NEWS)
  })

  test('a comparison needs several sources', () => {
    assert.equal(classify('compare Vite and webpack').needsMultipleSources, true)
    assert.equal(classify('how do I install vite').needsMultipleSources, false)
  })

  test('query variants are built from keywords, not the whole sentence', () => {
    const question = 'What is the latest stable version of React?'
    const queries = planQueries(question, classify(question))
    assert.equal(queries[0], question, 'the original comes first')
    for (const query of queries.slice(1)) {
      assert.ok(!query.includes('What is the latest'), `a variant must not restate the sentence: ${query}`)
    }
  })

  test('core terms drop question words and keep names', () => {
    assert.equal(coreTerms('What is the latest stable version of React?'), 'latest stable version React')
    assert.ok(coreTerms('How do I use the Next.js app router?').includes('router'))
  })
})

describe('cache freshness', () => {
  afterEach(() => clearCache())

  test('a live question gets a very short TTL', () => {
    assert.ok(isTimeSensitive('latest react version'))
    assert.ok(ttlFor('latest react version') <= 60_000, 'current-information queries must expire fast')
  })

  test('a reference question may be cached for much longer', () => {
    assert.ok(ttlFor('what is photosynthesis', 'reference') > 60 * 60 * 1000)
  })

  test('news sits between the two', () => {
    const news = ttlFor('election results analysis', 'news')
    assert.ok(news > 60_000 && news <= 900_000, `news TTL was ${news}`)
  })

  test('cache statistics report counts, not queries', () => {
    const stats = cacheStats()
    assert.equal(typeof stats.entries, 'number')
    assert.ok(!JSON.stringify(stats).includes('query'))
  })
})

describe('result merging and ranking', () => {
  const make = (url, extra = {}) =>
    makeResult({ title: extra.title ?? url, url, provider: extra.provider ?? 'p1', ...extra })

  test('the same page from two providers becomes one corroborated result', () => {
    const merged = mergeResults(
      [
        { provider: 'a', results: [make('https://example.com/page', { provider: 'a' })] },
        { provider: 'b', results: [make('https://www.example.com/page/', { provider: 'b' })] },
      ],
      { intent: classify('x'), query: 'x', maxResults: 10 },
    )
    assert.equal(merged.length, 1, 'www and a trailing slash are the same page')
    assert.equal(merged[0].agreementCount, 2)
    assert.deepEqual(merged[0].providers.sort(), ['a', 'b'])
  })

  test('tracking parameters do not create duplicates', () => {
    assert.equal(dedupeKey('https://example.com/a?utm_source=x&id=1'), dedupeKey('https://example.com/a?id=1'))
    assert.notEqual(dedupeKey('https://example.com/a'), dedupeKey('https://example.com/b'))
  })

  test('authoritative domains outrank content farms', () => {
    const intent = classify('how do I use fetch')
    const official = rankScore(make('https://developer.mozilla.org/en-US/docs/Web/API/fetch'), {
      intent,
      agreementCount: 1,
      query: 'fetch',
    })
    const farm = rankScore(make('https://www.w3schools.com/js/js_fetch.asp'), {
      intent,
      agreementCount: 1,
      query: 'fetch',
    })
    assert.ok(official > farm, `official docs (${official}) should outrank a content farm (${farm})`)
  })

  test('a package registry outranks a blog for a version question', () => {
    const intent = classify('latest react version')
    const registry = rankScore(make('https://www.npmjs.com/package/react'), {
      intent,
      agreementCount: 1,
      query: 'react version',
    })
    const blog = rankScore(make('https://medium.com/@someone/react-versions'), {
      intent,
      agreementCount: 1,
      query: 'react version',
    })
    assert.ok(registry > blog, `the registry (${registry}) should outrank a blog (${blog})`)
  })

  test('a stale article is penalised on a current-information question', () => {
    const intent = classify('latest react version')
    const fresh = rankScore(make('https://example.com/a', { publishedAt: new Date().toISOString() }), {
      intent,
      agreementCount: 1,
      query: 'react',
    })
    const old = rankScore(
      make('https://example.com/b', { publishedAt: new Date(Date.now() - 900 * 86_400_000).toISOString() }),
      { intent, agreementCount: 1, query: 'react' },
    )
    assert.ok(fresh > old, 'a recent source must outrank a two-year-old one for a live question')
  })

  test('freshness is not demanded when the question is timeless', () => {
    const intent = classify('what is photosynthesis')
    assert.equal(intent.timeSensitive, false)
    const old = rankScore(
      make('https://example.com/a', { publishedAt: new Date(Date.now() - 900 * 86_400_000).toISOString() }),
      { intent, agreementCount: 1, query: 'photosynthesis' },
    )
    assert.ok(old > -1, 'an older article can still be the best one written')
  })

  test('corroboration by independent providers raises a result', () => {
    const intent = classify('x')
    const alone = rankScore(make('https://example.com/a'), { intent, agreementCount: 1, query: 'x' })
    const corroborated = rankScore(make('https://example.com/a'), { intent, agreementCount: 3, query: 'x' })
    assert.ok(corroborated > alone)
  })
})

describe('provider health and circuit breaking', () => {
  afterEach(() => resetHealth())

  test('failures are classified so the cooldown fits the cause', () => {
    assert.equal(classifyFailure('http_429', 429), 'rate_limited')
    assert.equal(classifyFailure('unauthorized', 401), 'auth')
    assert.equal(classifyFailure('http_503', 503), 'server')
    assert.equal(classifyFailure('timeout'), 'timeout')
    assert.equal(classifyFailure('blocked_hostname'), 'blocked')
  })

  test('a bad key opens the breaker immediately — retrying cannot help', () => {
    noteFailure('brave', 'unauthorized', 401)
    assert.equal(isOpen('brave'), true)
    assert.equal(healthOf('brave').state, 'unhealthy')
  })

  test('a rate limit opens the breaker immediately', () => {
    noteFailure('serper', 'http_429', 429)
    assert.equal(isOpen('serper'), true)
  })

  test('one transient failure does not open the breaker', () => {
    noteFailure('tavily', 'http_503', 503)
    assert.equal(isOpen('tavily'), false, 'a single 5xx should not disable a provider')
  })

  test('repeated failures do open it', () => {
    for (let i = 0; i < 3; i++) noteFailure('tavily', 'http_503', 503)
    assert.equal(isOpen('tavily'), true)
  })

  test('a success closes the breaker and clears the streak', () => {
    for (let i = 0; i < 3; i++) noteFailure('exa', 'http_503', 503)
    assert.equal(isOpen('exa'), true)
    noteSuccess('exa', { latencyMs: 120, results: 5 })
    assert.equal(isOpen('exa'), false)
    assert.equal(healthOf('exa').consecutiveFailures, 0)
  })

  test("a provider's own Retry-After is honoured", () => {
    noteRetryAfter('brave', '30')
    const cooldown = healthOf('brave').cooldownMs
    assert.ok(cooldown > 25_000 && cooldown <= 30_000, `expected about 30s, got ${cooldown}`)
  })

  test('an absurd Retry-After is capped rather than trusted', () => {
    noteRetryAfter('brave', String(60 * 60 * 24))
    assert.ok(healthOf('brave').cooldownMs <= 600_000, 'a provider must not disable itself all session')
  })

  test('an unhealthy provider is skipped by selection', () => {
    noteFailure('duckduckgo', 'unauthorized', 401)
    const chosen = selectProviders({ type: SEARCH_TYPE.WEB, limit: 9 }).map((p) => p.id)
    assert.ok(!chosen.includes('duckduckgo'), 'an open breaker must exclude the provider')
  })

  test('health reports latency and success rate, not queries', () => {
    noteSuccess('wikipedia', { latencyMs: 200, results: 3 })
    noteSuccess('wikipedia', { latencyMs: 400, results: 2 })
    const health = healthOf('wikipedia')
    assert.equal(health.requests, 2)
    assert.equal(health.successRate, 1)
    assert.equal(health.averageLatencyMs, 300)
    assert.ok(!JSON.stringify(health).includes('query'))
  })
})

describe('page extraction', () => {
  test('navigation, cookie banners and scripts are stripped', () => {
    const html =
      '<html><head><title>T</title></head><body>' +
      '<nav class="navbar">Home About</nav>' +
      '<div class="cookie-consent">We use cookies</div>' +
      '<div id="newsletter-signup">Subscribe</div>' +
      '<aside class="related-posts">More stories</aside>' +
      '<article><h1>Real</h1><p>This is the article body and it is long enough to be kept as a passage.</p></article>' +
      '<footer>Copyright</footer><script>alert(1)</script></body></html>'
    const text = htmlToText(html)

    for (const noise of ['Home About', 'cookies', 'Subscribe', 'More stories', 'Copyright', 'alert']) {
      assert.ok(!text.includes(noise), `${noise} should have been stripped`)
    }
    assert.ok(text.includes('article body'), 'the content must survive')
  })

  test('entities are decoded, including numeric ones', () => {
    assert.equal(decodeEntities('a &amp; b &lt;c&gt; &#8212; &mdash; &hellip;'), 'a & b <c> — — …')
    assert.equal(decodeEntities('&unknownentity;'), '&unknownentity;', 'an unknown entity is left alone')
  })

  test('a lone surrogate does not throw', () => {
    assert.doesNotThrow(() => decodeEntities('&#xD800;'))
  })

  test('navigation debris is not treated as a passage', () => {
    const passages = toPassages(
      'Home | About | Contact | Blog | Shop | Careers | Legal\n\nThis is a real paragraph of prose that says something and ends properly.',
    )
    assert.equal(passages.length, 1)
    assert.ok(passages[0].includes('real paragraph'))
  })

  test('a passage needs sentence structure', () => {
    assert.equal(toPassages('SHORT\n\nALSO SHORT').length, 0)
  })
})

describe('normalisation', () => {
  test('relative ages become real dates', () => {
    const iso = normaliseDate('3 days ago')
    assert.ok(iso, 'a relative age must parse')
    const days = (Date.now() - new Date(iso).getTime()) / 86_400_000
    assert.ok(days > 2.5 && days < 3.5, `expected about 3 days, got ${days}`)
  })

  test('an absurd date is rejected rather than stored', () => {
    assert.equal(normaliseDate('0001-01-01'), null)
    assert.equal(normaliseDate('not a date'), null)
    assert.equal(normaliseDate(null), null)
  })

  test('domains drop www and lowercase', () => {
    assert.equal(domainOf('https://WWW.Example.COM/a'), 'example.com')
    assert.equal(domainOf('not a url'), '')
  })

  test('a result is normalised even from sparse input', () => {
    const result = makeResult({ url: 'https://example.com/a', provider: 'p' })
    assert.equal(result.domain, 'example.com')
    assert.equal(result.title, 'example.com', 'a missing title falls back to the domain')
    assert.ok(result.retrievedAt, 'retrieval time is always recorded')
  })
})

describe('source comparison', () => {
  test('one changelog listing several versions is not a conflict', () => {
    const { notes } = compareSources([
      { title: 'Releases', snippet: '19.2.6 and 19.1.7 and 19.0.6 patches', publishedAt: '2026-08-01T00:00:00Z' },
      { title: 'npm', snippet: 'latest 19.2.8', publishedAt: '2026-08-02T00:00:00Z' },
    ])
    assert.ok(!notes.some((n) => /disagree/i.test(n)), `same major version is not a conflict: ${notes.join(' | ')}`)
  })

  test('two sources on different major versions is a conflict', () => {
    const { notes } = compareSources([
      { title: 'Old post', snippet: 'the current version is 18.3.1', publishedAt: '2026-08-01T00:00:00Z' },
      { title: 'npm', snippet: 'the current version is 19.2.8', publishedAt: '2026-08-02T00:00:00Z' },
    ])
    assert.ok(notes.some((n) => /disagree/i.test(n)), 'a major-version disagreement must be reported')
  })

  test('years are not mistaken for version numbers', () => {
    const { versionCandidates } = compareSources([{ title: 'a', snippet: 'published 2024.01 and 2026.02' }])
    assert.equal(versionCandidates.length, 0)
  })

  test('undated sources are called out', () => {
    const { notes } = compareSources([{ title: 'a', snippet: 'some text' }])
    assert.ok(notes.some((n) => /publication date/i.test(n)))
  })

  test('a wide date spread is called out', () => {
    const { notes } = compareSources([
      { title: 'a', snippet: 'x', publishedAt: '2020-01-01T00:00:00Z' },
      { title: 'b', snippet: 'y', publishedAt: '2026-01-01T00:00:00Z' },
    ])
    assert.ok(notes.some((n) => /span/i.test(n)))
  })
})

describe('vision routing', () => {
  afterEach(() => resetVisionRoutes())

  test('an explicit capability refusal is permanent, not transient', () => {
    assert.equal(
      classifyVisionFailure({ code: 'provider_error', message: 'No target in combo has confirmed vision support' }),
      'no_vision_capability',
    )
    assert.equal(
      classifyVisionFailure({ code: 'bad_request', message: 'The selected model does not support image input' }),
      'no_vision_capability',
    )
  })

  test('a bare bad_request is ambiguous, not a capability verdict', () => {
    // Cooling a genuinely vision-capable route for six hours after one bad
    // minute is worse than trying it again
    assert.equal(
      classifyVisionFailure({ code: 'bad_request', message: 'That request could not be processed.' }),
      'rejected_image',
    )
  })

  test('transient failures are classified as transient', () => {
    assert.equal(classifyVisionFailure({ code: 'rate_limited', message: '429' }), 'rate_limited')
    assert.equal(classifyVisionFailure({ code: 'model_unavailable', message: 'blocked by Vercel egress' }), 'unavailable')
    assert.equal(classifyVisionFailure({ code: 'timeout', message: 'timed out' }), 'timeout')
    assert.equal(classifyVisionFailure({ code: 'auth_failed', message: '401' }), 'auth')
  })

  test('candidates are listed with health and never claim unverified success', () => {
    for (const candidate of visionCandidates()) {
      assert.ok(candidate.model, 'a candidate needs a model')
      assert.equal(typeof candidate.healthy, 'boolean')
      assert.equal(typeof candidate.successes, 'number')
    }
  })
})
