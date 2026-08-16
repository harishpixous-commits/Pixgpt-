const Database = require('C:/Users/haris/node24/npm-global/node_modules/omniroute/node_modules/better-sqlite3')
const fs = require('fs')
const path = require('path')

const dir = 'C:/Users/haris/.omniroute/db_backups'
const files = fs.readdirSync(dir).filter((f) => f.startsWith('live-backup-')).sort()
if (files.length === 0) { console.log('NO BACKUP FILES'); process.exit(1) }
const file = path.join(dir, files[files.length - 1])
console.log('checking:', file)

const db = new Database(file, { readonly: true })
const integrity = db.pragma('integrity_check', { simple: true })
console.log('integrity:', integrity)

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name)
console.log('tables:', tables.join(', '))

// Providers/config rows: names only, never values
for (const t of tables) {
  if (/provider/i.test(t)) {
    try {
      const rows = db.prepare(`SELECT * FROM "${t}" LIMIT 20`).all()
      console.log(`table ${t}: ${rows.length} sample rows`)
      for (const r of rows.slice(0, 5)) {
        const keys = Object.keys(r).filter((k) => /name|id|label|provider/i.test(k))
        const info = keys.map((k) => `${k}=${String(r[k]).slice(0, 60)}`).join(' ')
        console.log('  ', info || '(no name-ish columns)')
      }
    } catch (e) { console.log(`table ${t}: err ${e.message}`) }
  }
}
db.close()
