const Database = require('C:/Users/haris/node24/npm-global/node_modules/omniroute/node_modules/better-sqlite3')
const fs = require('fs')
const path = require('path')

const dir = 'C:/Users/haris/.omniroute/db_backups'
const file = fs.readdirSync(dir).filter((f) => f.startsWith('live-backup-')).sort().pop()
const db = new Database(path.join(dir, file), { readonly: true })

const interesting = ['api_keys', 'combos', 'key_value', 'upstream_proxy_config', 'model_capabilities', 'registered_keys', 'provider_nodes', 'free_proxies', 'reasoning_routing_rules', 'domain_fallback_chains']
for (const t of interesting) {
  try {
    const n = db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n
    console.log(`table ${t}: ${n} rows`)
    if (n > 0) {
      const rows = db.prepare(`SELECT * FROM "${t}" LIMIT 3`).all()
      for (const r of rows) {
        const redacted = Object.fromEntries(
          Object.entries(r).map(([k, v]) => {
            const vs = String(v ?? '')
            return [k, /key|secret|token|password|credential|apikey|api_key/i.test(k) ? '<redacted>' : vs.slice(0, 80)]
          }),
        )
        console.log('   ', JSON.stringify(redacted))
      }
    }
  } catch (e) { console.log(`table ${t}: err ${e.message}`) }
}
db.close()
