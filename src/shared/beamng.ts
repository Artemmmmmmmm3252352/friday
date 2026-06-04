import type {
  AppLanguage,
  BeamngCommandInput,
  BeamngConfig,
  BeamngSavedPlace,
  BeamngTextCommandResolution,
} from '@contracts'

export function createDefaultBeamngConfig(): BeamngConfig {
  return {
    gamePath: '',
    autoLaunch: false,
    defaultVehicleId: 'ego',
    savedPlaces: [],
  }
}

export function normalizeBeamngConfig(input: Partial<BeamngConfig> | null | undefined): BeamngConfig {
  return {
    gamePath: normalizeBeamngPath(input?.gamePath),
    autoLaunch: Boolean(input?.autoLaunch),
    defaultVehicleId: normalizeNonEmptyString(input?.defaultVehicleId, 'ego'),
    savedPlaces: normalizeBeamngSavedPlaces(input?.savedPlaces),
  }
}

export function normalizeBeamngSavedPlaces(
  savedPlaces: BeamngConfig['savedPlaces'] | Partial<BeamngSavedPlace>[] | null | undefined,
): BeamngSavedPlace[] {
  if (!Array.isArray(savedPlaces)) {
    return []
  }

  const byId = new Map<string, BeamngSavedPlace>()
  for (const rawPlace of savedPlaces) {
    const normalized = normalizeBeamngSavedPlace(rawPlace)
    if (!normalized) {
      continue
    }

    byId.set(normalized.id, normalized)
  }

  return [...byId.values()]
}

export function normalizeBeamngSavedPlace(rawPlace: Partial<BeamngSavedPlace> | null | undefined): BeamngSavedPlace | null {
  if (!rawPlace) {
    return null
  }

  const name = normalizeNonEmptyString(rawPlace.name, '')
  const waypointId = normalizeNonEmptyString(rawPlace.waypointId, '')
  if (!name || !waypointId) {
    return null
  }

  const aliases = normalizeAliases(rawPlace.aliases)
  const id = normalizeNonEmptyString(rawPlace.id, slugify(name))
  return {
    id,
    name,
    waypointId,
    aliases,
  }
}

export function parseDeterministicBeamngCommand(
  text: string,
  config: BeamngConfig,
): BeamngTextCommandResolution {
  const normalized = normalizeLookup(text)
  if (!normalized) {
    return createUnmatchedResolution(false)
  }

  if (LANE_OFF_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { matched: true, isBeamngRelated: true, source: 'deterministic', command: { type: 'lane_off' } }
  }

  if (LANE_ON_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { matched: true, isBeamngRelated: true, source: 'deterministic', command: { type: 'lane_on' } }
  }

  if (STOP_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { matched: true, isBeamngRelated: true, source: 'deterministic', command: { type: 'stop' } }
  }

  if (DISABLE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { matched: true, isBeamngRelated: true, source: 'deterministic', command: { type: 'disable' } }
  }

  if (TRAFFIC_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { matched: true, isBeamngRelated: true, source: 'deterministic', command: { type: 'traffic' } }
  }

  if (AGGRESSIVE_TRAFFIC_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { matched: true, isBeamngRelated: true, source: 'deterministic', command: { type: 'aggressive_traffic' } }
  }

  if (RANDOM_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { matched: true, isBeamngRelated: true, source: 'deterministic', command: { type: 'random' } }
  }

  if (SPAN_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { matched: true, isBeamngRelated: true, source: 'deterministic', command: { type: 'span' } }
  }

  const goToName = extractGoToPlaceName(text)
  if (goToName) {
    const place = resolveBeamngPlace(goToName, config.savedPlaces)
    if (!place) {
      return createUnmatchedResolution(true)
    }

    return {
      matched: true,
      isBeamngRelated: true,
      source: 'deterministic',
      command: { type: 'go_to_place', placeId: place.id },
      placeId: place.id,
    }
  }

  return createUnmatchedResolution(isBeamngRelatedText(text))
}

export function isBeamngRelatedText(text: string): boolean {
  const normalized = normalizeLookup(text)
  if (!normalized) {
    return false
  }

  return BEAMNG_RELATED_PATTERNS.some((pattern) => pattern.test(normalized))
}

export function resolveBeamngPlace(rawName: string, savedPlaces: BeamngSavedPlace[]): BeamngSavedPlace | null {
  const normalizedNeedle = normalizeLookup(rawName)
  if (!normalizedNeedle) {
    return null
  }

  const exact = savedPlaces.find((place) => getPlaceNeedles(place).some((value) => value === normalizedNeedle))
  if (exact) {
    return exact
  }

  const partial =
    savedPlaces.find((place) =>
      getPlaceNeedles(place).some((value) => value.includes(normalizedNeedle) || normalizedNeedle.includes(value)),
    ) ?? null
  if (partial) {
    return partial
  }

  const needleTokens = tokenizeLookup(normalizedNeedle)
  let bestMatch: { place: BeamngSavedPlace; score: number } | null = null
  for (const place of savedPlaces) {
    for (const value of getPlaceNeedles(place)) {
      const score = scoreLookupOverlap(needleTokens, tokenizeLookup(value))
      if (score >= 0.6 && (!bestMatch || score > bestMatch.score)) {
        bestMatch = { place, score }
      }
    }
  }

  return bestMatch?.place ?? null
}

export function buildBeamngIntentPrompt(
  text: string,
  language: AppLanguage,
  savedPlaces: BeamngSavedPlace[],
): string {
  const placeLines =
    savedPlaces.length > 0
      ? savedPlaces
          .map((place) => `- ${place.id}: ${place.name}${place.aliases.length ? ` (aliases: ${place.aliases.join(', ')})` : ''}`)
          .join('\n')
      : '- none'

  return [
    language === 'ru'
      ? 'Ты скрытый роутер BeamNG-команд внутри Friday.'
      : 'You are the hidden BeamNG command router inside Friday.',
    language === 'ru'
      ? 'Верни только JSON без markdown и комментариев.'
      : 'Return JSON only with no markdown and no commentary.',
    '{"mode":"pass"}',
    '{"mode":"command","command":"traffic"}',
    '{"mode":"command","command":"aggressive_traffic"}',
    '{"mode":"command","command":"random"}',
    '{"mode":"command","command":"span"}',
    '{"mode":"command","command":"stop"}',
    '{"mode":"command","command":"disable"}',
    '{"mode":"command","command":"lane_on"}',
    '{"mode":"command","command":"lane_off"}',
    '{"mode":"command","command":"go_to_place","placeId":"garage"}',
    language === 'ru'
      ? 'Используй только перечисленные команды. Если запрос не про BeamNG AI или целевая точка неясна, верни {"mode":"pass"}.'
      : 'Use only the listed commands. If the request is not about BeamNG AI or the destination is unclear, return {"mode":"pass"}.',
    language === 'ru' ? 'Сохраненные точки:' : 'Saved places:',
    placeLines,
    language === 'ru' ? `Запрос пользователя: ${text}` : `User request: ${text}`,
  ].join('\n')
}

export function parseBeamngIntentReply(
  replyText: string,
  config: BeamngConfig,
): BeamngTextCommandResolution {
  const parsed = tryParseJsonObject(replyText)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return createUnmatchedResolution(false)
  }

  const record = parsed as Record<string, unknown>
  const mode = normalizeNonEmptyString(String(record.mode ?? ''), '')
  if (mode === 'pass') {
    return createUnmatchedResolution(true)
  }

  if (mode !== 'command') {
    return createUnmatchedResolution(true)
  }

  const commandName = normalizeNonEmptyString(String(record.command ?? ''), '')
  switch (commandName) {
    case 'traffic':
    case 'aggressive_traffic':
    case 'random':
    case 'span':
    case 'stop':
    case 'disable':
    case 'lane_on':
    case 'lane_off':
      return { matched: true, isBeamngRelated: true, source: 'openclaw', command: { type: commandName } }
    case 'go_to_place': {
      const placeId = typeof record.placeId === 'string' ? record.placeId.trim() : ''
      const placeName = typeof record.placeName === 'string' ? record.placeName.trim() : ''
      const place =
        config.savedPlaces.find((candidate) => candidate.id === placeId) ??
        (placeName ? resolveBeamngPlace(placeName, config.savedPlaces) : null)

      if (!place) {
        return createUnmatchedResolution(true)
      }

      return {
        matched: true,
        isBeamngRelated: true,
        source: 'openclaw',
        command: { type: 'go_to_place', placeId: place.id },
        placeId: place.id,
      }
    }
    default:
      return createUnmatchedResolution(true)
  }
}

export function formatBeamngCommandLabel(command: BeamngCommandInput, placeName?: string): string {
  switch (command.type) {
    case 'traffic':
      return 'traffic'
    case 'aggressive_traffic':
      return 'aggressive traffic'
    case 'random':
      return 'random'
    case 'span':
      return 'span'
    case 'stop':
      return 'stopping'
    case 'disable':
      return 'disabled'
    case 'lane_on':
      return 'lane on'
    case 'lane_off':
      return 'lane off'
    case 'go_to_place':
      return placeName ? `go to ${placeName}` : 'go to place'
  }
}

function createUnmatchedResolution(isBeamngRelated: boolean): BeamngTextCommandResolution {
  return { matched: false, isBeamngRelated, source: 'none' }
}

function extractGoToPlaceName(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) {
    return null
  }

  const match = trimmed.match(
    /(?:^|\b)(?:езжай|поезжай|въезжай|двигайся|направляйся|отправляйся|рули|go|drive|head)\s+(?:к|в|на|to)\s+(.+)$/iu,
  )
  if (!match) {
    return null
  }

  return normalizePlaceTarget(match[1])
}

function normalizePlaceTarget(value: string): string {
  return value
    .trim()
    .replace(/[.!?]+$/u, '')
    .replace(/^(?:the)\s+/iu, '')
    .trim()
}

function getPlaceNeedles(place: BeamngSavedPlace): string[] {
  return [place.id, place.name, ...place.aliases].map((value) => normalizeLookup(value)).filter(Boolean)
}

function normalizeAliases(value: string[] | null | undefined): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return Array.from(new Set(value.map((entry) => normalizeNonEmptyString(entry, '')).filter(Boolean)))
}

function normalizeBeamngPath(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/[\\/]+$/, '')
}

function normalizeNonEmptyString(value: string | null | undefined, fallback: string): string {
  const trimmed = (value ?? '').trim()
  return trimmed || fallback
}

function slugify(value: string): string {
  return normalizeLookup(value).replace(/[^a-z0-9а-я]+/giu, '-').replace(/^-+|-+$/g, '') || 'beamng-place'
}

function normalizeLookup(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokenizeLookup(value: string): string[] {
  return value.split(' ').filter(Boolean)
}

function scoreLookupOverlap(needleTokens: string[], candidateTokens: string[]): number {
  if (needleTokens.length === 0 || candidateTokens.length === 0) {
    return 0
  }

  let matched = 0
  for (const token of needleTokens) {
    if (candidateTokens.some((candidate) => candidate.includes(token) || token.includes(candidate))) {
      matched += 1
    }
  }

  return matched / needleTokens.length
}

function tryParseJsonObject(replyText: string): unknown | null {
  const trimmed = replyText.trim()
  if (!trimmed) {
    return null
  }

  try {
    return JSON.parse(trimmed)
  } catch {
    const firstBrace = trimmed.indexOf('{')
    const lastBrace = trimmed.lastIndexOf('}')
    if (firstBrace < 0 || lastBrace <= firstBrace) {
      return null
    }

    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1))
    } catch {
      return null
    }
  }
}

const TRAFFIC_PATTERNS = [
  /(?:включи|запусти|активируй).*(?:автопилот|трафик)/iu,
  /(?:продолжай|возобнови|поехали|поезжай дальше).*(?:движение|автопилот)?/iu,
  /(?:enable|turn on|start).*(?:autopilot|traffic)/iu,
  /^(?:автопилот|autopilot|traffic mode)$/iu,
]

const AGGRESSIVE_TRAFFIC_PATTERNS = [
  /(?:агрессивн|жестк|дерзк).*(?:автопилот|режим|езда|трафик|езжай|катайся)/iu,
  /(?:агрессивно|жестко|дерзко).*(?:езжай|катайся|веди машину|поезжай)/iu,
  /(?:aggressive|aggressively).*(?:traffic|autopilot|drive|driving|mode)/iu,
]

const RANDOM_PATTERNS = [
  /(?:катайся|ездий|езди|двигайся).*(?:случайн|рандом|хаотич)/iu,
  /(?:explore|roam|drive).*(?:random|around)/iu,
]

const SPAN_PATTERNS = [
  /(?:объезжай|исследуй|проедь|катайся).*(?:карту|дороги|всю карту|весь город|всю сеть дорог)/iu,
  /(?:span|cover the map|drive the whole map|explore the road network)/iu,
]

const STOP_PATTERNS = [/^(?:остановись|стоп|stop|halt)$/iu, /(?:остановись|stop the car|bring the car to a stop)/iu]

const DISABLE_PATTERNS = [
  /(?:выключи|отключи).*(?:автопилот|ии|ai)/iu,
  /(?:disable|turn off).*(?:autopilot|ai)/iu,
]

const LANE_ON_PATTERNS = [
  /(?:держись|держись в|оставайся в|держи|держи машину).*(?:полосе|полосы|ряду|в полосе|в полосе движения)/iu,
  /^(?:держись|держи)\s+полосы$/iu,
  /(?:stay|keep|drive).*(?:in lane|the lane)/iu,
]

const LANE_OFF_PATTERNS = [
  /(?:не держись|можно без|выключи).*(?:полосы|движение по полосе)/iu,
  /(?:lane off|leave the lane logic|don t stay in lane|do not stay in lane|disable lane)/iu,
]

const BEAMNG_RELATED_PATTERNS = [
  /\bbeamng\b/iu,
  /\bautopilot\b/iu,
  /\btraffic\b/iu,
  /\blane\b/iu,
  /\bwaypoint\b/iu,
  /\bvehicle ai\b/iu,
  /\bdrive there\b/iu,
  /автопилот/iu,
  /полос/iu,
  /маршрут/iu,
  /вейпоинт/iu,
  /езжай/iu,
  /поезжай/iu,
  /въезжай/iu,
  /карта/iu,
  /дорог/iu,
  /beam/iu,
]
