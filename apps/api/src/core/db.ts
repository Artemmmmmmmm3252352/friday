import { Pool, type PoolClient, type QueryResultRow } from 'pg'

export class Database {
  readonly pool: Pool

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
    })
  }

  async query<T extends QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
    const result = await this.pool.query<T>(text, values)
    return result.rows
  }

  async withTransaction<T>(handler: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await handler(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
