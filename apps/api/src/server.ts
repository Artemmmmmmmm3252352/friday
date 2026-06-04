import { createApiApp } from './app'
import { loadApiConfig } from './core/config'
import { Database } from './core/db'
import { ensureSchema } from './core/schema'

async function main(): Promise<void> {
  const config = loadApiConfig()
  const database = new Database(config.databaseUrl)
  await ensureSchema(database)
  const app = await createApiApp(database)

  await app.listen({
    host: config.host,
    port: config.port,
  })
}

void main()
