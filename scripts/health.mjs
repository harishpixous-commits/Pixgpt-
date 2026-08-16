import { GATEWAY_IDS, describeGateway, getGateway } from '../server/gateway/index.mjs'

/**
 * `npm run gateway:health` — verifies the selected AI gateway from the same
 * code path the server uses, without starting PixGPT. Prints no secrets.
 */
const gw = describeGateway()

console.log(`PixGPT -> ${gw.label}`)
console.log(`  provider  : ${gw.gateway}   (supported: ${GATEWAY_IDS.join(', ')})`)
console.log(`  base URL  : ${gw.baseUrl}`)
console.log(`  api key   : ${gw.apiKey}`)
console.log(`  default   : ${gw.defaultModel}`)
console.log(`  aliases   : ${Object.entries(gw.aliases).map(([k, v]) => `${k}->${v}`).join(', ')}`)
console.log(`  fallback  : ${gw.fallbackModels.join(', ') || 'none (gateway-native routing only)'}`)
console.log(`  license   : ${gw.license}`)
console.log(
  `  supports  : ${Object.entries(gw.capabilities)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(', ')}`,
)

if (gw.configProblems.length > 0) {
  console.log('')
  for (const p of gw.configProblems) console.log(`  ! ${p}`)
}

console.log('')

const { adapter, client } = getGateway()
const health = await client.checkHealth()
console.log(`  reachable     : ${health.reachable ? 'yes' : 'no'}`)
console.log(`  authenticated : ${health.authenticated === null ? 'unknown' : health.authenticated ? 'yes' : 'no'}`)
if (health.code) console.log(`  code          : ${health.code}`)

if (health.reachable && adapter.capabilities.models) {
  try {
    const models = await client.listModels()
    console.log(`  models        : ${models.length}`)
    for (const m of models.slice(0, 10)) console.log(`      - ${m}`)
    if (models.length > 10) console.log(`      … and ${models.length - 10} more`)
  } catch (error) {
    console.log(`  models        : unavailable (${error.code ?? 'error'})`)
  }
} else if (!adapter.capabilities.models) {
  console.log('  models        : catalogue not exposed by this gateway')
}

console.log('')
console.log(health.ok ? `✔ ${gw.label} ready` : `✖ ${gw.label} not ready`)
process.exit(health.ok ? 0 : 1)
