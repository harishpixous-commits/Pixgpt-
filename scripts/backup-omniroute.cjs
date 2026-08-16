// Online backup of the local OmniRoute config database.
// Uses the better-sqlite3 bundled with the running OmniRoute install, so the
// backup is crash-consistent even while the server is live (SQLite online
// backup API, not a file copy).
const path = require('path')
const Database = require('C:/Users/haris/node24/npm-global/node_modules/omniroute/node_modules/better-sqlite3')

const src = 'C:/Users/haris/.omniroute/storage.sqlite'
const dest = path.join('C:/Users/haris/.omniroute/db_backups', `live-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`)

async function main() {
  const db = new Database(src, { readonly: true })
  try {
    await db.backup(dest)
  } finally {
    db.close()
  }
  console.log('backup written:', dest)
}

main().catch((e) => {
  console.error('backup failed:', e)
  process.exit(1)
})
