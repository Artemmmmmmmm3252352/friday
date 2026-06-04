import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

export class FridayLogger {
  private readonly logPath: string

  constructor(userDataPath: string) {
    this.logPath = path.join(userDataPath, 'logs', 'friday.log')
  }

  getPath(): string {
    return this.logPath
  }

  async info(message: string): Promise<void> {
    await this.write('INFO', message)
  }

  async error(message: string): Promise<void> {
    await this.write('ERROR', message)
  }

  private async write(level: string, message: string): Promise<void> {
    await mkdir(path.dirname(this.logPath), { recursive: true })
    const line = `[${new Date().toISOString()}] [${level}] ${message}\n`
    await appendFile(this.logPath, line, 'utf8')
  }
}
