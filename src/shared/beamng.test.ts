import { describe, expect, it } from 'vitest'

import { createDefaultBeamngConfig, parseBeamngIntentReply, parseDeterministicBeamngCommand } from './beamng'

describe('beamng shared helpers', () => {
  it('matches traffic mode deterministically', () => {
    const result = parseDeterministicBeamngCommand('включи автопилот', createDefaultBeamngConfig())
    expect(result).toEqual({
      matched: true,
      isBeamngRelated: true,
      source: 'deterministic',
      command: { type: 'traffic' },
    })
  })

  it('resolves saved place aliases', () => {
    const result = parseDeterministicBeamngCommand('езжай к гаражу', {
      ...createDefaultBeamngConfig(),
      savedPlaces: [
        {
          id: 'garage',
          name: 'Гараж',
          waypointId: 'wp_garage',
          aliases: ['гаражу'],
        },
      ],
    })

    expect(result).toEqual({
      matched: true,
      isBeamngRelated: true,
      source: 'deterministic',
      command: { type: 'go_to_place', placeId: 'garage' },
      placeId: 'garage',
    })
  })

  it('matches lane hold phrasing used in game mode', () => {
    const result = parseDeterministicBeamngCommand('держись полосы', createDefaultBeamngConfig())
    expect(result).toEqual({
      matched: true,
      isBeamngRelated: true,
      source: 'deterministic',
      command: { type: 'lane_on' },
    })
  })

  it('resolves saved places from longer natural phrases', () => {
    const result = parseDeterministicBeamngCommand('езжай в подготовка подлпотного кролика', {
      ...createDefaultBeamngConfig(),
      savedPlaces: [
        {
          id: 'rabbit-prep',
          name: 'Подготовка подлпотного кролика',
          waypointId: 'wp_rabbit_prep',
          aliases: ['кролик', 'подготовка кролика'],
        },
      ],
    })

    expect(result).toEqual({
      matched: true,
      isBeamngRelated: true,
      source: 'deterministic',
      command: { type: 'go_to_place', placeId: 'rabbit-prep' },
      placeId: 'rabbit-prep',
    })
  })

  it('matches random roaming command deterministically', () => {
    const result = parseDeterministicBeamngCommand('катайся случайно по карте', createDefaultBeamngConfig())
    expect(result).toEqual({
      matched: true,
      isBeamngRelated: true,
      source: 'deterministic',
      command: { type: 'random' },
    })
  })

  it('matches aggressive traffic command deterministically', () => {
    const result = parseDeterministicBeamngCommand('агрессивный режим', createDefaultBeamngConfig())
    expect(result).toEqual({
      matched: true,
      isBeamngRelated: true,
      source: 'deterministic',
      command: { type: 'aggressive_traffic' },
    })
  })

  it('matches span mode command deterministically', () => {
    const result = parseDeterministicBeamngCommand('исследуй карту', createDefaultBeamngConfig())
    expect(result).toEqual({
      matched: true,
      isBeamngRelated: true,
      source: 'deterministic',
      command: { type: 'span' },
    })
  })

  it('parses openclaw fallback json', () => {
    const result = parseBeamngIntentReply('{"mode":"command","command":"go_to_place","placeId":"garage"}', {
      ...createDefaultBeamngConfig(),
      savedPlaces: [
        {
          id: 'garage',
          name: 'Garage',
          waypointId: 'wp_garage',
          aliases: [],
        },
      ],
    })

    expect(result).toEqual({
      matched: true,
      isBeamngRelated: true,
      source: 'openclaw',
      command: { type: 'go_to_place', placeId: 'garage' },
      placeId: 'garage',
    })
  })
})
