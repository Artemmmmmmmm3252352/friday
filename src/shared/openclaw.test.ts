import { describe, expect, it } from 'vitest'

import {
  buildAgentArgs,
  buildCronAddArgs,
  buildGatewayRunArgs,
  getDefaultOpenClawPaths,
  isUnusableAgentReply,
  parseAgentStdout,
} from './openclaw'

describe('openclaw helpers', () => {
  it('builds agent args with json and session id', () => {
    const args = buildAgentArgs('session-1', 'ping')
    expect(args.slice(0, 8)).toEqual([
      'agent',
      '--local',
      '--json',
      '--session-id',
      'session-1',
      '--timeout',
      '45',
      '--message',
    ])
    expect(args[8]).toContain('ping')
    expect(args[8]).toContain('Never output NO_REPLY')
  })

  it('wraps explicit implementation briefs in execution mode', () => {
    const brief = [
      'Создай простую программу на Python с графическим интерфейсом.',
      'Сначала создай папку.',
      'В этой папке создай файл main.py.',
      'Убедись, что программа запускается командой python main.py.',
    ].join('\n')

    const args = buildAgentArgs('session-1', brief)

    expect(args.slice(0, 10)).toEqual(['agent', '--local', '--json', '--session-id', 'session-1', '--thinking', 'high', '--timeout', '90', '--message'])
    expect(args[10]).toContain('Создай простую программу на Python')
    expect(args[10]).toContain('Важно: это уже полное ТЗ.')
    expect(args[10]).toContain('Не задавай уточняющих вопросов')
  })

  it('builds gateway run args', () => {
    expect(buildGatewayRunArgs()).toEqual([
      'gateway',
      'run',
      '--allow-unconfigured',
      '--auth',
      'none',
      '--bind',
      'loopback',
      '--force',
    ])
  })

  it('builds default per-user OpenClaw lookup paths', () => {
    expect(
      getDefaultOpenClawPaths({
        homeDir: 'C:\\Users\\Alice',
        appDataDir: 'C:\\Users\\Alice\\AppData\\Roaming',
      }),
    ).toEqual([
      'C:\\Users\\Alice\\AppData\\Roaming\\npm\\openclaw.cmd',
      'C:\\Users\\Alice\\AppData\\Roaming\\npm\\openclaw',
      'C:\\Users\\Alice\\OpenCLO\\openclaw.cmd',
      'C:\\Users\\Alice\\OpenCLO\\openclaw',
      'C:\\Users\\Alice\\OpenClaw\\openclaw.cmd',
      'C:\\Users\\Alice\\OpenClaw\\openclaw',
    ])
  })

  it('builds cron add args without delivery', () => {
    expect(buildCronAddArgs('Launch Calculator', '2m', 'открой калькулятор')).toEqual([
      'cron',
      'add',
      '--name',
      'Launch Calculator',
      '--at',
      '2m',
      '--session',
      'isolated',
      '--agent',
      'main',
      '--message',
      'открой калькулятор',
      '--no-deliver',
      '--delete-after-run',
      '--json',
    ])
  })

  it('flags unusable bridge replies', () => {
    expect(isUnusableAgentReply('HEARTBEAT_OK')).toBe(true)
    expect(isUnusableAgentReply('8c67e4f9-eb67-4d57-b0c4-3b831e813765')).toBe(true)
    expect(isUnusableAgentReply('Агент вернул JSON без текста ответа.')).toBe(true)
    expect(isUnusableAgentReply('I am sorry, I cannot open applications on your computer.')).toBe(true)
    expect(isUnusableAgentReply('Я по-прежнему не могу получать доступ к информации в реальном времени.')).toBe(true)
    expect(
      isUnusableAgentReply(
        'Конечно! Какую именно программу с графическим интерфейсом вы хотели бы создать? Опишите, пожалуйста, ее функциональность.',
      ),
    ).toBe(true)
    expect(isUnusableAgentReply('What specific execution mode are you referring to?')).toBe(true)
    expect(isUnusableAgentReply('Хорошо, я готов. Пожалуйста, предоставьте полное техническое задание на выполнение.')).toBe(true)
    expect(isUnusableAgentReply('Привет! Чем могу помочь?')).toBe(false)
  })

  it('parses json stdout and extracts reply text', () => {
    const parsed = parseAgentStdout(JSON.stringify({ result: { replyText: 'Mission ready' } }))
    expect(parsed.replyText).toBe('Mission ready')
    expect(parsed.rawJson).toEqual({ result: { replyText: 'Mission ready' } })
  })

  it('ignores heartbeat-only stdout', () => {
    const parsed = parseAgentStdout('HEARTBEAT_OK')

    expect(parsed.replyText).toBe('Агент не вернул ответ в чат.')
    expect(parsed.rawJson).toBeNull()
  })

  it('ignores heartbeat lines and uses the real json reply', () => {
    const parsed = parseAgentStdout(`HEARTBEAT_OK\n{"result":{"replyText":"Привет!"}}`)

    expect(parsed.replyText).toBe('Привет!')
    expect(parsed.rawJson).toEqual({ result: { replyText: 'Привет!' } })
  })

  it('does not mistake session ids for assistant replies', () => {
    const parsed = parseAgentStdout(
      JSON.stringify({
        runId: '3270b3a5-1084-4b9c-a2f5-364e7afe0d86',
        status: 'ok',
        result: {
          payloads: [{ text: 'HEARTBEAT_OK', mediaUrl: null }],
          meta: {
            agentMeta: {
              sessionId: '8c67e4f9-eb67-4d57-b0c4-3b831e813765',
            },
          },
        },
      }),
    )

    expect(parsed.replyText).toBe('Агент вернул JSON без текста ответа.')
  })

  it('converts API error payloads into a readable message', () => {
    const parsed = parseAgentStdout(
      JSON.stringify({
        error: {
          code: 400,
          message: 'User location is not supported for the API use.',
          status: 'FAILED_PRECONDITION',
        },
      }),
    )

    expect(parsed.replyText).toBe(
      'Провайдер модели отклонил запрос по региону. Нужен поддерживаемый регион или другой LLM-провайдер.',
    )
  })
})
