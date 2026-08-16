/* ============================================================
   Compatibility shim — the OmniRoute integration lives on.

   PixGPT now supports several interchangeable gateways, so the
   client that used to live in this file was generalised into:

     gateway/openai-compatible.mjs   the shared transport
     gateway/adapters/omniroute.mjs  OmniRoute's specifics
     gateway/index.mjs               selection + config

   Nothing about OmniRoute's behaviour changed, and it remains the
   default gateway. This module stays so that any existing import
   of `server/omniroute.mjs` keeps working; new code should import
   from `server/gateway/index.mjs` instead.
   ============================================================ */

import { getGateway } from './gateway/index.mjs'

export { GatewayError } from './gateway/errors.mjs'

export const streamCompletion = (...args) => getGateway().client.streamCompletion(...args)
export const completion = (...args) => getGateway().client.completion(...args)
export const listModels = (...args) => getGateway().client.listModels(...args)
export const checkHealth = (...args) => getGateway().client.checkHealth(...args)
export const modelChain = (...args) => getGateway().client.modelChain(...args)
