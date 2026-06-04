import { Database } from '../../api/src/core/db'
import { PlatformRepository } from '../../api/src/core/repository'
import { loadRuntimeEnv } from '../../api/src/core/runtimeEnv'
import { ensureSchema } from '../../api/src/core/schema'

const runtimeEnv = loadRuntimeEnv()
const databaseUrl = runtimeEnv.FRIDAY_DATABASE_URL ?? ''
const intervalMs = Number(runtimeEnv.FRIDAY_WORKER_INTERVAL_MS ?? 60_000)
const shouldEnsureSchema = runtimeEnv.FRIDAY_WORKER_ENSURE_SCHEMA === 'true'

if (!databaseUrl) {
  throw new Error('FRIDAY_DATABASE_URL is required')
}

const database = new Database(databaseUrl)
const repository = new PlatformRepository(database)

async function tick(): Promise<void> {
  await repository.deliverDueReminders()
  await repository.runRuleEngine()
}

async function main(): Promise<void> {
  if (shouldEnsureSchema) {
    await ensureSchema(database)
  }
  await tick()

  if (runtimeEnv.FRIDAY_WORKER_ONCE === 'true') {
    await database.close()
    return
  }

  setInterval(() => {
    void tick()
  }, intervalMs)
}

void main()
