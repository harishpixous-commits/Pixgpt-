import { GatewayError, classifyNetworkError, classifyStatus, gatewayError } from './errors.mjs'

/* ============================================================
   Shared OpenAI-compatible client
   -------------------------------
   Every supported gateway speaks the OpenAI wire format, so they
   all share this one transport rather than each shipping its own
   HTTP/SSE handling. An adapter only supplies what differs:
   headers, base path, body tweaks, status classification.

   This is the OmniRoute client generalised — the request flow,
   idle-timeout behaviour, SSE parsing and fallback semantics are
   unchanged, so OmniRoute behaves exactly as before.
   ============================================================ */

/**
 * True when a reply carries no actual information.
 *
 * Strips whitespace, markdown emphasis and punctuation; if nothing is left, the
 * model said nothing. Deliberately conservative — "42", "Yes" and "No" all
 * survive, because those are real answers.
 */
export function isContentFree(content) {
  if (typeof content !== 'string') return true
  const meaningful = content
    .replace(/[*_`~#>\-]/g, '')
    .replace(/[\s.,;:!?()[\]{}'"‘’“”—–…]/g, '')
  return meaningful.length === 0
}

/**
 * @param {object} adapter  gateway descriptor (see adapters/)
 * @param {object} cfg      resolved config: { baseUrl, apiKey, timeoutMs, healthPath, fallbackModels, ... }
 * @param {object} log      logger
 * @param {object} [hooks]  optional routing hooks:
 *   - resolveChain(requested, context) → { chain, meta } | null — the model
 *     registry's chain for this request. Returning null keeps the built-in
 *     alias + configured-fallback behaviour.
 *   - reportOutcome(model, { ok, ms, error }) — every attempt, so the registry
 *     learns from ordinary traffic instead of needing background probes.
 *   - clientFor(model) → a client belonging to whichever gateway owns that
 *     model, or null for "this one". A chain may legitimately span gateways;
 *     sending an OpenRouter id to OmniRoute would simply 404.
 *   - timeoutFor(model, ceiling) → how long to wait for this route before
 *     giving up, derived from its measured latency. Defaults to the ceiling.
 */
export function createClient(adapter, cfg, log, hooks = {}) {
  /*
   * An adapter may classify only the statuses that are special to its gateway
   * and return nothing for the rest, rather than having to reimplement the
   * whole table. Freebuff needs exactly one rule (its 429 carries a queue
   * marker); everything else should behave identically to every other gateway.
   */
  const classify = adapter.classifyStatus
    ? (status, body) => adapter.classifyStatus(status, body) ?? classifyStatus(status, body)
    : classifyStatus
  const report = (model, outcome) => {
    try {
      hooks.reportOutcome?.(model, outcome)
    } catch (error) {
      // Telemetry must never break a request that otherwise succeeded
      log.warn('outcome reporter threw', { model, detail: error?.message })
    }
  }

  function headers(extra) {
    const base = { 'Content-Type': 'application/json', Accept: 'application/json', ...extra }
    // An adapter may replace auth entirely (Portkey needs provider headers)
    return adapter.buildHeaders ? adapter.buildHeaders(base, cfg) : withBearer(base, cfg)
  }

  function withBearer(base, config) {
    if (config.apiKey) base.Authorization = `Bearer ${config.apiKey}`
    return base
  }

  /**
   * Idle timeout: the clock resets on every chunk, so a slow-but-alive stream
   * is never killed while a silent one still fails fast. `clientSignal` lets a
   * browser disconnect abort the upstream request too.
   */
  async function call(path, body, clientSignal, { connectTimeoutMs } = {}) {
    const controller = new AbortController()
    let timedOut = false

    const fail = () => {
      timedOut = true
      controller.abort()
    }

    // 1. Connection/first-response timeout — replaced by the idle timer once
    //    headers arrive, so it only guards the pre-response phase.
    let timer = setTimeout(fail, connectTimeoutMs ?? cfg.connectTimeoutMs)
    // 2. Absolute ceiling for the whole exchange, never refreshed.
    const hardTimer = setTimeout(fail, cfg.maxStreamMs)

    const onClientAbort = () => controller.abort()
    clientSignal?.addEventListener('abort', onClientAbort, { once: true })

    const cleanup = () => {
      clearTimeout(timer)
      clearTimeout(hardTimer)
      clientSignal?.removeEventListener('abort', onClientAbort)
    }

    try {
      const response = await fetch(`${cfg.baseUrl}${path}`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        cleanup()
        throw classify(response.status, text)
      }

      // 3. Headers are in: switch to the idle timeout for the body.
      clearTimeout(timer)
      timer = setTimeout(fail, cfg.timeoutMs)

      return { response, clearIdle: cleanup, resetIdle: () => timer.refresh?.() }
    } catch (error) {
      cleanup()
      if (error instanceof GatewayError) throw error
      if (clientSignal?.aborted && !timedOut) throw gatewayError('client_closed', 'client disconnected')
      throw classifyNetworkError(error, timedOut)
    }
  }

  /** Request body in the OpenAI shape, with adapter-specific additions. */
  function buildBody({ model, messages, temperature, maxTokens, tools, stream }) {
    const body = { model, messages, stream }
    if (typeof temperature === 'number') body.temperature = temperature
    if (typeof maxTokens === 'number') body.max_tokens = maxTokens
    if (Array.isArray(tools) && tools.length > 0 && adapter.capabilities.tools) body.tools = tools
    return adapter.buildBody ? adapter.buildBody(body, cfg) : body
  }

  /* ---------- non-streaming ---------- */

  async function completionOnce(model, request, clientSignal) {
    /**
     * A non-streaming reply arrives only once the model has finished
     * generating, so the *connect* timeout has to cover generation time — the
     * 15s default is right for chat but far too short for an agent turn that
     * writes a whole file. Callers pass `timeoutMs` for those.
     */
    /*
     * An explicit `timeoutMs` from the caller always wins — an agent turn that
     * writes a whole file legitimately needs minutes. Otherwise the budget
     * comes from what this route has actually been doing, so a route measured
     * in milliseconds is not given fifteen seconds to stay silent.
     */
    const { response, clearIdle } = await call(
      '/chat/completions',
      buildBody({ ...request, model, stream: false }),
      clientSignal,
      { connectTimeoutMs: request.timeoutMs ?? hooks.timeoutFor?.(model, cfg.connectTimeoutMs) },
    )
    try {
      const data = await response.json()
      const message = data?.choices?.[0]?.message
      const content = message?.content
      const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : []

      // A tool-calling reply legitimately has empty content, so content is only
      // required when the model returned no tool calls.
      if (typeof content !== 'string' && toolCalls.length === 0) {
        throw gatewayError('malformed_response', 'missing choices[0].message.content')
      }

      /*
       * Some routes answer a real question with "." or "**." — a 200 carrying no
       * content. Reported as success it looks like the model considered the
       * question and had nothing to say, which is worse than an error: the
       * caller acts on an empty answer. Treated as a retryable failure, the
       * chain simply moves to the next model.
       */
      if (toolCalls.length === 0 && isContentFree(content)) {
        throw gatewayError('malformed_response', `model returned no usable content (${JSON.stringify(String(content).slice(0, 20))})`)
      }

      return {
        content: typeof content === 'string' ? content : '',
        toolCalls,
        finishReason: data?.choices?.[0]?.finish_reason ?? null,
        model: data?.model ?? model,
        usage: data?.usage,
      }
    } catch (error) {
      if (error instanceof GatewayError) throw error
      throw gatewayError('malformed_response', error?.message)
    } finally {
      clearIdle()
    }
  }

  /* ---------- streaming ---------- */

  /**
   * The transport for one candidate.
   *
   * Returns this client's own functions unless the registry says another
   * gateway owns the model, in which case the request is executed there. That
   * indirection is what makes a chain like
   * `openrouter:anthropic/claude-* → omniroute:auto/best-coding` work at all.
   */
  function transportFor(model) {
    const other = hooks.clientFor?.(model)
    return other && other !== self ? other : null
  }

  async function streamOnce(model, request, clientSignal, onToken, onModel) {
    const { response, clearIdle, resetIdle } = await call(
      '/chat/completions',
      buildBody({ ...request, model, stream: true }),
      clientSignal,
      { connectTimeoutMs: hooks.timeoutFor?.(model, cfg.connectTimeoutMs) },
    )

    let streamed = 0
    let reportedModel = false

    try {
      const decoder = new TextDecoder()
      let buffer = ''

      for await (const chunk of response.body) {
        resetIdle()
        buffer += decoder.decode(chunk, { stream: true })

        let boundary
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const rawEvent = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)

          for (const line of rawEvent.split(/\r?\n/)) {
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (!payload) continue
            if (payload === '[DONE]') return { streamed }

            let parsed
            try {
              parsed = JSON.parse(payload)
            } catch {
              // A single unparseable frame should not kill a working stream
              log.warn('skipped unparseable SSE frame', { gateway: adapter.id, model })
              continue
            }

            if (parsed?.error) {
              const message = parsed.error?.message ?? ''
              throw gatewayError(
                /rate/i.test(message) ? 'rate_limited' : /quota/i.test(message) ? 'quota_exceeded' : 'provider_error',
                message,
              )
            }

            if (!reportedModel && parsed?.model) {
              reportedModel = true
              onModel?.(parsed.model)
            }

            const delta = adapter.extractDelta
              ? adapter.extractDelta(parsed)
              : parsed?.choices?.[0]?.delta?.content
            if (typeof delta === 'string' && delta.length > 0) {
              streamed += delta.length
              onToken(delta)
            }
          }
        }
      }
      return { streamed }
    } catch (error) {
      if (error instanceof GatewayError) throw Object.assign(error, { streamed })
      if (clientSignal?.aborted) {
        throw Object.assign(gatewayError('client_closed', 'client disconnected'), { streamed })
      }
      throw Object.assign(classifyNetworkError(error, false), { streamed })
    } finally {
      clearIdle()
    }
  }

  /* ---------- model resolution + fallback ---------- */

  function resolveModel(requested) {
    if (!requested) return cfg.modelAliases[cfg.defaultAlias] ?? cfg.defaultModel
    return cfg.modelAliases[requested] ?? requested
  }

  /**
   * The model chain for one request: the resolved model, then any configured
   * fallbacks. This layers on top of — it never replaces — the gateway's own
   * routing. Gateways that fan out internally (OmniRoute `auto`, LiteLLM
   * router, Bifrost, Portkey configs) still do so; this only covers a pinned
   * model being unavailable.
   *
   * When a chain resolver is installed (the model registry) its ranked chain is
   * used instead. Anything it cannot answer — an empty registry, a discovery
   * failure, a model class with no candidates — falls straight through to the
   * static behaviour below.
   */
  /*
   * Returns the chain *and* why it was chosen, together. Keeping them in one
   * return value rather than a `lastChain` field on the client matters: several
   * requests are in flight at once, and a shared field would hand request B's
   * explanation to request A.
   */
  function buildChain(requested, context = {}) {
    const { requiresVision = false, noFallback = false } = context

    /*
     * `noFallback` exists for probing. A probe must reach the model it names:
     * if the chain silently moved on, the registry would record the fallback's
     * success against the probed model and learn something false about it.
     */
    if (noFallback) return { chain: [resolveModel(requested)], meta: null }

    const resolved = hooks.resolveChain?.(requested, context)
    if (resolved?.chain?.length > 0) return { chain: resolved.chain, meta: resolved.meta ?? null }

    const chain = [resolveModel(requested)]
    // A vision request may only fall back to routes that can also see.
    const fallbacks = requiresVision ? cfg.visionFallbackModels ?? [] : cfg.fallbackModels
    for (const m of fallbacks) if (!chain.includes(m)) chain.push(m)
    return { chain, meta: null }
  }

  /** Kept for callers that only want the ids (`/api/chat` logs the first one). */
  function modelChain(requested, context = {}) {
    return buildChain(requested, context).chain
  }

  async function streamCompletion(request, clientSignal, onToken, onModel) {
    const { chain, meta } = buildChain(request.model, {
      requiresVision: Boolean(request.requiresVision),
      noFallback: Boolean(request.noFallback),
      text: request.routingText,
      mode: request.routingMode,
      hasTools: Array.isArray(request.tools) && request.tools.length > 0,
      hasImages: Boolean(request.requiresVision),
      estimatedTokens: request.estimatedTokens,
    })
    let lastError

    for (const [index, candidate] of chain.entries()) {
      const started = Date.now()
      try {
        log.debug('stream attempt', { gateway: adapter.id, model: candidate, attempt: index + 1, of: chain.length })
        const elsewhere = transportFor(candidate)
        const { streamed } = elsewhere
          ? await elsewhere.streamOne(candidate, request, clientSignal, onToken, onModel)
          : await streamOnce(candidate, request, clientSignal, onToken, onModel)
        report(candidate, { ok: true, ms: Date.now() - started, via: 'stream' })
        return { model: candidate, routedTo: candidate, streamed, fellBack: index > 0, chain, routing: meta }
      } catch (error) {
        lastError = error
        const alreadyStreamed = (error.streamed ?? 0) > 0
        const isLast = index === chain.length - 1

        if (error.code === 'client_closed') throw error
        // A client disconnect is not the route's fault; nothing else is exempt
        report(candidate, { ok: false, ms: Date.now() - started, error, via: 'stream' })
        if (alreadyStreamed || !shouldContinueChain(error) || isLast) {
          log.warn('stream failed', {
            gateway: adapter.id,
            model: candidate,
            code: error.code,
            streamed: error.streamed ?? 0,
            detail: error.detail,
          })
          throw error
        }
        log.warn('stream failed, falling back', {
          gateway: adapter.id,
          from: candidate,
          to: chain[index + 1],
          code: error.code,
        })
      }
    }
    throw lastError ?? gatewayError('provider_error', 'no models attempted')
  }

  /*
   * Whether the chain should move on after this failure.
   *
   * `error.retryable` answers "is this worth retrying", which is not quite the
   * same question. `invalid_api_key` is not retryable *on the same route* — but
   * this gateway fronts several upstream pools with separate credentials, and a
   * 401 from one of them says nothing about the next. Aborting the whole chain
   * on it surfaced "the gateway rejected this server's credentials" to users
   * while several verified routes sat unused further down the chain.
   */
  const shouldContinueChain = (error) =>
    error.retryable || error.code === 'invalid_api_key' || error.code === 'quota_exceeded'

  async function completion(request, clientSignal) {
    const { chain, meta } = buildChain(request.model, {
      requiresVision: Boolean(request.requiresVision),
      noFallback: Boolean(request.noFallback),
      text: request.routingText,
      mode: request.routingMode,
      hasTools: Array.isArray(request.tools) && request.tools.length > 0,
      hasImages: Boolean(request.requiresVision),
      estimatedTokens: request.estimatedTokens,
    })
    let lastError

    for (const [index, candidate] of chain.entries()) {
      const started = Date.now()
      try {
        const elsewhere = transportFor(candidate)
        const result = elsewhere
          ? await elsewhere.completeOne(candidate, request, clientSignal)
          : await completionOnce(candidate, request, clientSignal)
        report(candidate, { ok: true, ms: Date.now() - started, via: 'completion' })
        /*
         * `result.model` is what the provider called itself, which is often not
         * the catalogue id — `oc/deepseek-v4-flash-free` comes back as plain
         * `deepseek-v4-flash-free`. `routedTo` keeps the id we actually asked
         * for, so the registry can still be looked up.
         */
        return { ...result, routedTo: candidate, fellBack: index > 0, chain, routing: meta }
      } catch (error) {
        lastError = error
        if (error.code === 'client_closed') throw error
        report(candidate, { ok: false, ms: Date.now() - started, error, via: 'completion' })
        if (!shouldContinueChain(error) || index === chain.length - 1) throw error
        log.warn('completion failed, falling back', {
          gateway: adapter.id,
          from: candidate,
          to: chain[index + 1],
          code: error.code,
        })
      }
    }
    throw lastError
  }

  /* ---------- catalogue + health ---------- */

  async function listModels(clientSignal) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.min(cfg.timeoutMs, 15_000))
    clientSignal?.addEventListener('abort', () => controller.abort(), { once: true })
    try {
      const response = await fetch(`${cfg.baseUrl}/models`, { headers: headers(), signal: controller.signal })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw classify(response.status, text)
      }
      const data = await response.json()
      return Array.isArray(data?.data) ? data.data.map((m) => m?.id).filter((id) => typeof id === 'string') : []
    } catch (error) {
      if (error instanceof GatewayError) throw error
      throw classifyNetworkError(error, controller.signal.aborted)
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Liveness probe, cached briefly so UI polling stays off the gateway's hot
   * path. Falls back to the models endpoint for gateways with no dedicated
   * health route.
   */
  let healthCache = { at: 0, value: null }
  const HEALTH_TTL_MS = 5_000

  async function checkHealth() {
    const now = Date.now()
    if (healthCache.value && now - healthCache.at < HEALTH_TTL_MS) return healthCache.value

    const result = {
      gateway: adapter.id,
      ok: false,
      reachable: false,
      authenticated: null,
      code: null,
      baseUrl: cfg.baseUrl,
    }

    let origin
    try {
      origin = new URL(cfg.baseUrl).origin
    } catch {
      result.code = 'bad_request'
      healthCache = { at: now, value: result }
      return result
    }

    if (cfg.healthPath) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 5_000)
      try {
        const probe = await fetch(`${origin}${cfg.healthPath}`, { signal: controller.signal })
        result.reachable = probe.ok || probe.status < 500
      } catch (error) {
        result.code = classifyNetworkError(error, controller.signal.aborted).code
        healthCache = { at: now, value: result }
        return result
      } finally {
        clearTimeout(timer)
      }
    }

    if (adapter.capabilities.models) {
      // Confirm credentials (and, for gateways with no health route, liveness)
      try {
        await listModels()
        result.reachable = true
        result.authenticated = true
        result.ok = true
      } catch (error) {
        if (!cfg.healthPath) result.reachable = error.code !== 'gateway_unavailable'
        result.authenticated = error.code === 'invalid_api_key' ? false : null
        result.code = error.code
        result.ok = false
      }
    } else if (!cfg.healthPath) {
      // No health route and no model catalogue (Higress, Portkey): the most we
      // can honestly assert is that something answered on the origin.
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 5_000)
      try {
        await fetch(origin, { signal: controller.signal })
        result.reachable = true
        result.ok = true // credentials cannot be checked without sending a completion
      } catch (error) {
        result.code = classifyNetworkError(error, controller.signal.aborted).code
      } finally {
        clearTimeout(timer)
      }
    } else {
      // Health route answered; credentials remain unverified until first use
      result.ok = result.reachable
    }

    healthCache = { at: now, value: result }
    return result
  }

  /*
   * `streamOne` / `completeOne` are the single-attempt primitives, exposed so a
   * client belonging to another gateway can be driven for one candidate without
   * re-entering its chain logic — which would otherwise start a nested chain.
   */
  const self = {
    streamCompletion,
    completion,
    listModels,
    checkHealth,
    modelChain,
    buildChain,
    resolveModel,
    streamOne: streamOnce,
    completeOne: completionOnce,
  }
  return self
}
