import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
const DEFAULT_STATE_DIR = path.join(DEFAULT_APPDATA, 'friday', 'state')
const DEFAULT_PROFILE_DIR = path.join(DEFAULT_STATE_DIR, 'playwright-browser-profile')
const DEFAULT_NAVIGATION_TIMEOUT_MS = 60_000
const DEFAULT_ACTION_TIMEOUT_MS = 15_000
const DEFAULT_VIEWPORT_WIDTH = 1440
const DEFAULT_VIEWPORT_HEIGHT = 900
const INTERACTION_SNAPSHOT_LIMIT = 12
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))

const GUIDANCE = [
  'You have dedicated Playwright browser automation tools for interactive sites and forms.',
  'Prefer playwright_browser_* over the built-in browser tool whenever the user wants to open sites, click, type, submit, or extract content after interaction.',
  'These tools use a separate managed browser window. They do not take over an already-open human Chrome tab.',
  'Start with playwright_browser_open, then use playwright_browser_snapshot to inspect visible controls before acting.',
  'For quizzes, surveys, and forms, prefer playwright_browser_form_snapshot to understand grouped questions before answering.',
  'When answering a structured form, prefer playwright_browser_form_answer so actions stay scoped to the right question card.',
  'Prefer label, text, placeholder, name, or role-based targets before fragile CSS selectors.',
  'After navigation or form submission, use playwright_browser_snapshot or playwright_browser_extract instead of guessing page state.',
  'Close the browser with playwright_browser_close when the session is no longer needed.',
].join('\n')

const emptyObjectSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {},
}

const locatorRoleEnum = ['button', 'link', 'tab', 'menuitem', 'checkbox', 'radio', 'switch', 'textbox', 'combobox', 'option']

const locatorTargetSchema = {
  selector: {
    type: 'string',
    description: 'Optional CSS selector for the target element.',
  },
  text: {
    type: 'string',
    description: 'Visible text for the target element.',
  },
  role: {
    type: 'string',
    enum: locatorRoleEnum,
    description: 'Optional ARIA role to use with text or name matching.',
  },
  name: {
    type: 'string',
    description: 'Accessible name or form field name for the target element.',
  },
  label: {
    type: 'string',
    description: 'Associated label text for an input or control.',
  },
  placeholder: {
    type: 'string',
    description: 'Placeholder text for an input field.',
  },
  testId: {
    type: 'string',
    description: 'Optional test id for the target element.',
  },
  exact: {
    type: 'boolean',
    description: 'Match text, labels, and names exactly. Defaults to false.',
  },
}

const plugin = {
  id: 'playwright-mcp',
  name: 'Playwright MCP',
  description: 'Browser automation tools for opening sites, clicking elements, filling forms, and extracting page data with Playwright.',
  register(api) {
    const runtimeConfig = resolveRuntimeConfig(api.pluginConfig)
    const runtime = createRuntime(runtimeConfig)

    api.registerTool(createOpenTool(runtime), { optional: true })
    api.registerTool(createSnapshotTool(runtime), { optional: true })
    api.registerTool(createClickTool(runtime), { optional: true })
    api.registerTool(createFillFormTool(runtime), { optional: true })
    api.registerTool(createFormSnapshotTool(runtime), { optional: true })
    api.registerTool(createFormAnswerTool(runtime), { optional: true })
    api.registerTool(createExtractTool(runtime), { optional: true })
    api.registerTool(createCloseTool(runtime), { optional: true })
    api.on('before_prompt_build', async () => ({
      prependSystemContext: GUIDANCE,
    }))
  },
}

export default plugin

function createRuntime(runtimeConfig) {
  let sessionPromise = null

  async function ensureSession() {
    let attempts = 0
    while (attempts < 2) {
      attempts += 1

      if (!sessionPromise) {
        sessionPromise = launchSession(runtimeConfig).catch((error) => {
          sessionPromise = null
          throw error
        })
      }

      const session = await sessionPromise
      if (await ensureSessionPage(session)) {
        return session
      }

      await disposeSession(session)
      sessionPromise = null
    }

    throw new Error('Failed to create a healthy Playwright browser session.')
  }

  async function resetSession() {
    const current = sessionPromise
    sessionPromise = null
    if (!current) {
      return
    }

    const session = await current.catch(() => null)
    if (!session) {
      return
    }

    await disposeSession(session)
  }

  return {
    config: runtimeConfig,
    ensureSession,
    resetSession,
  }
}

function createOpenTool(runtime) {
  return {
    name: 'playwright_browser_open',
    label: 'Playwright Open',
    description: 'Open a URL in a persistent Playwright browser window and return the current page state.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: {
          type: 'string',
          description: 'Absolute URL to open.',
        },
        waitUntil: {
          type: 'string',
          enum: ['load', 'domcontentloaded', 'networkidle', 'commit'],
          description: 'Optional Playwright waitUntil mode. Defaults to domcontentloaded.',
        },
      },
      required: ['url'],
    },
    execute: async (_toolCallId, rawParams) => {
      const params = asRecord(rawParams)
      const url = readRequiredString(params.url, 'url')
      const waitUntil = readOptionalString(params.waitUntil) || 'domcontentloaded'
      const session = await runtime.ensureSession()
      await session.page.goto(url, {
        waitUntil,
        timeout: runtime.config.navigationTimeoutMs,
      })
      await settlePage(session.page, {
        longWait: true,
        navigationTimeoutMs: runtime.config.navigationTimeoutMs,
      })
      await session.page.bringToFront()
      return toolJson(await describePage(session.page, { includeInteractive: true }))
    },
  }
}

function createSnapshotTool(runtime) {
  return {
    name: 'playwright_browser_snapshot',
    label: 'Playwright Snapshot',
    description: 'Read a structured snapshot of the current Playwright page, including text preview and interactive elements.',
    parameters: emptyObjectSchema,
    execute: async () => {
      const session = await runtime.ensureSession()
      return toolJson(await describePage(session.page, { includeInteractive: true }))
    },
  }
}

function createClickTool(runtime) {
  return {
    name: 'playwright_browser_click',
    label: 'Playwright Click',
    description: 'Click an element on the current Playwright page using text, label, role, test id, or CSS selector.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...locatorTargetSchema,
        button: {
          type: 'string',
          enum: ['left', 'right', 'middle'],
          description: 'Mouse button. Defaults to left.',
        },
        doubleClick: {
          type: 'boolean',
          description: 'Whether to double click. Defaults to false.',
        },
        waitForNavigation: {
          type: 'boolean',
          description: 'Wait longer for navigation or SPA updates after clicking. Defaults to false.',
        },
      },
    },
    execute: async (_toolCallId, rawParams) => {
      const params = asRecord(rawParams)
      const target = readLocatorTarget(params, 'click target')
      const session = await runtime.ensureSession()
      const button = readOptionalString(params.button) || 'left'
      const clickCount = readOptionalBoolean(params.doubleClick) ? 2 : 1
      const waitForNavigation = readOptionalBoolean(params.waitForNavigation)
      const locator = await resolveClickLocator(session.page, target, runtime.config.actionTimeoutMs)

      await primeLocator(locator, runtime.config.actionTimeoutMs)
      await locator.click({
        button,
        clickCount,
        timeout: runtime.config.actionTimeoutMs,
      })
      await settlePage(session.page, {
        longWait: waitForNavigation,
        navigationTimeoutMs: runtime.config.navigationTimeoutMs,
      })

      return toolJson(await describePage(session.page, { includeInteractive: true }))
    },
  }
}

function createFillFormTool(runtime) {
  return {
    name: 'playwright_browser_fill_form',
    label: 'Playwright Fill Form',
    description: 'Fill one or more form fields on the current page using label, placeholder, name, test id, or selector, and optionally submit the form.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fields: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ...locatorTargetSchema,
              value: {
                type: 'string',
                description: 'Value to type into the field.',
              },
            },
            required: ['value'],
          },
        },
        submitSelector: {
          type: 'string',
          description: 'Optional CSS selector for the submit button to click after filling.',
        },
        submitText: {
          type: 'string',
          description: 'Visible text for the submit button or control.',
        },
        submitRole: {
          type: 'string',
          enum: locatorRoleEnum,
          description: 'Optional role for the submit control.',
        },
        submitName: {
          type: 'string',
          description: 'Accessible name for the submit control.',
        },
        pressEnterOnLastField: {
          type: 'boolean',
          description: 'Press Enter on the last field after filling. Defaults to false.',
        },
        waitForNavigation: {
          type: 'boolean',
          description: 'Wait longer for navigation or SPA updates after submission. Defaults to true when submitting.',
        },
      },
      required: ['fields'],
    },
    execute: async (_toolCallId, rawParams) => {
      const params = asRecord(rawParams)
      const rawFields = Array.isArray(params.fields) ? params.fields : null
      if (!rawFields || rawFields.length === 0) {
        throw new Error('fields must contain at least one target/value pair.')
      }

      const session = await runtime.ensureSession()
      let lastLocator = null
      for (const rawField of rawFields) {
        const field = asRecord(rawField)
        const target = readLocatorTarget(field, 'fields[]')
        const value = readRequiredString(field.value, 'fields[].value')
        const locator = await resolveFieldLocator(session.page, target, runtime.config.actionTimeoutMs)
        await primeLocator(locator, runtime.config.actionTimeoutMs)
        await locator.fill(value, { timeout: runtime.config.actionTimeoutMs })
        lastLocator = locator
      }

      const submitTarget = readOptionalSubmitTarget(params)
      const wantsSubmit = Boolean(submitTarget) || readOptionalBoolean(params.pressEnterOnLastField)
      if (submitTarget) {
        const locator = await resolveClickLocator(session.page, submitTarget, runtime.config.actionTimeoutMs)
        await primeLocator(locator, runtime.config.actionTimeoutMs)
        await locator.click({ timeout: runtime.config.actionTimeoutMs })
      } else if (readOptionalBoolean(params.pressEnterOnLastField) && lastLocator) {
        await lastLocator.press('Enter', { timeout: runtime.config.actionTimeoutMs })
      }

      await settlePage(session.page, {
        longWait: wantsSubmit ? params.waitForNavigation !== false : false,
        navigationTimeoutMs: runtime.config.navigationTimeoutMs,
      })

      return toolJson(await describePage(session.page, { includeInteractive: true }))
    },
  }
}

function createFormSnapshotTool(runtime) {
  return {
    name: 'playwright_browser_form_snapshot',
    label: 'Playwright Form Snapshot',
    description: 'Extract grouped form or quiz questions from the current page, including question numbers, prompts, answer options, and text inputs.',
    parameters: emptyObjectSchema,
    execute: async () => {
      const session = await runtime.ensureSession()
      return toolJson({
        ok: true,
        url: session.page.url(),
        title: await safeCall(() => session.page.title(), ''),
        questions: await extractFormQuestions(session.page),
      })
    },
  }
}

function createFormAnswerTool(runtime) {
  return {
    name: 'playwright_browser_form_answer',
    label: 'Playwright Form Answer',
    description: 'Answer grouped form or quiz questions by question number or prompt, selecting an option or filling a text input inside the matching question card.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        answers: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              questionNumber: {
                type: 'number',
                description: 'Question number to answer, such as 1 or 3.',
              },
              questionText: {
                type: 'string',
                description: 'Question prompt text to match when questionNumber is unavailable.',
              },
              optionText: {
                type: 'string',
                description: 'Visible option text to click inside the matching question.',
              },
              inputValue: {
                type: 'string',
                description: 'Value to type into a text or number input inside the matching question.',
              },
              exact: {
                type: 'boolean',
                description: 'Match question and option text exactly. Defaults to false.',
              },
            },
          },
        },
        submit: {
          type: 'boolean',
          description: 'Click the submit button after answering. Defaults to false.',
        },
        submitText: {
          type: 'string',
          description: 'Optional visible text for the submit button. Defaults to common submit labels.',
        },
      },
      required: ['answers'],
    },
    execute: async (_toolCallId, rawParams) => {
      const params = asRecord(rawParams)
      const answers = Array.isArray(params.answers) ? params.answers : null
      if (!answers || answers.length === 0) {
        throw new Error('answers must contain at least one item.')
      }

      const session = await runtime.ensureSession()
      for (const rawAnswer of answers) {
        const answer = asRecord(rawAnswer)
        const questionLocator = await resolveQuestionCardLocator(session.page, answer, runtime.config.actionTimeoutMs)
        const exact = readOptionalBoolean(answer.exact)
        const optionText = readOptionalString(answer.optionText)
        const inputValue = readOptionalString(answer.inputValue)

        if (!optionText && !inputValue) {
          throw new Error('Each answer must include optionText or inputValue.')
        }

        if (optionText) {
          await clickQuestionOption(questionLocator, optionText, exact, runtime.config.actionTimeoutMs)
        }

        if (inputValue) {
          const inputLocator = await resolveQuestionInputLocator(questionLocator, runtime.config.actionTimeoutMs)
          await primeLocator(inputLocator, runtime.config.actionTimeoutMs)
          await inputLocator.fill(inputValue, { timeout: runtime.config.actionTimeoutMs })
        }
      }

      if (readOptionalBoolean(params.submit)) {
        const submitText = readOptionalString(params.submitText)
        const submitLocator = await resolveSubmitLocator(session.page, submitText, runtime.config.actionTimeoutMs)
        await primeLocator(submitLocator, runtime.config.actionTimeoutMs)
        await submitLocator.click({ timeout: runtime.config.actionTimeoutMs })
        await settlePage(session.page, {
          longWait: true,
          navigationTimeoutMs: runtime.config.navigationTimeoutMs,
        })
      } else {
        await settlePage(session.page, {
          longWait: false,
          navigationTimeoutMs: runtime.config.navigationTimeoutMs,
        })
      }

      return toolJson(await describePage(session.page, { includeInteractive: true }))
    },
  }
}

function createExtractTool(runtime) {
  return {
    name: 'playwright_browser_extract',
    label: 'Playwright Extract',
    description: 'Extract text, HTML, or links from the current page or a selected element.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        selector: {
          type: 'string',
          description: 'Optional CSS selector to scope extraction.',
        },
        mode: {
          type: 'string',
          enum: ['text', 'html', 'links'],
          description: 'Extraction mode. Defaults to text.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of links to return in links mode. Defaults to 20.',
        },
      },
    },
    execute: async (_toolCallId, rawParams) => {
      const params = asRecord(rawParams)
      const selector = readOptionalString(params.selector)
      const mode = readOptionalString(params.mode) || 'text'
      const limit = readOptionalNumber(params.limit) || 20
      const session = await runtime.ensureSession()
      const page = session.page

      if (mode === 'html') {
        const html = selector
          ? await page.locator(selector).first().innerHTML({ timeout: runtime.config.actionTimeoutMs })
          : await page.content()
        return toolJson({
          ok: true,
          mode,
          selector: selector || null,
          html,
        })
      }

      if (mode === 'links') {
        const links = await page.evaluate(
          ({ selector: scopedSelector, limit: maxItems }) => {
            const root = scopedSelector ? document.querySelector(scopedSelector) : document
            if (!root) {
              return []
            }

            return Array.from(root.querySelectorAll('a[href]'))
              .slice(0, maxItems)
              .map((link) => ({
                text: (link.textContent || '').trim(),
                href: link.href,
              }))
          },
          { selector, limit },
        )

        return toolJson({
          ok: true,
          mode,
          selector: selector || null,
          count: Array.isArray(links) ? links.length : 0,
          links,
        })
      }

      const text = selector
        ? await page.locator(selector).first().innerText({ timeout: runtime.config.actionTimeoutMs })
        : await page.locator('body').innerText({ timeout: runtime.config.actionTimeoutMs })

      return toolJson({
        ok: true,
        mode,
        selector: selector || null,
        text,
      })
    },
  }
}

function createCloseTool(runtime) {
  return {
    name: 'playwright_browser_close',
    label: 'Playwright Close',
    description: 'Close the active Playwright browser session.',
    parameters: emptyObjectSchema,
    execute: async () => {
      await runtime.resetSession()
      return toolJson({
        ok: true,
        message: 'Playwright browser session closed.',
      })
    },
  }
}

async function launchSession(runtimeConfig) {
  const playwright = loadPlaywright()
  const userDataDir = runtimeConfig.userDataDir
  await mkdir(userDataDir, { recursive: true })

  const launchErrors = []
  for (const channel of getChannelCandidates(runtimeConfig.browserChannel)) {
    try {
      const context = await playwright.chromium.launchPersistentContext(userDataDir, {
        channel: channel === 'chromium' ? undefined : channel,
        headless: runtimeConfig.headless,
        viewport: {
          width: runtimeConfig.viewportWidth,
          height: runtimeConfig.viewportHeight,
        },
        acceptDownloads: true,
        chromiumSandbox: false,
      })

      context.setDefaultNavigationTimeout(runtimeConfig.navigationTimeoutMs)
      context.setDefaultTimeout(runtimeConfig.actionTimeoutMs)

      const page = context.pages()[0] ?? (await context.newPage())
      await page.bringToFront()

      const session = {
        channel,
        context,
        page,
        closed: false,
      }
      context.once('close', () => {
        session.closed = true
      })

      return session
    } catch (error) {
      launchErrors.push(`${channel}: ${formatError(error)}`)
    }
  }

  throw new Error(`Failed to launch a supported browser channel. ${launchErrors.join(' | ')}`)
}

async function ensureSessionPage(session) {
  if (!session || session.closed) {
    return false
  }

  try {
    const browser = session.context.browser?.()
    if (browser && typeof browser.isConnected === 'function' && !browser.isConnected()) {
      session.closed = true
      return false
    }

    if (session.page && !session.page.isClosed()) {
      return true
    }

    const reusablePage = session.context.pages().find((page) => !page.isClosed())
    session.page = reusablePage ?? (await session.context.newPage())
    return !session.page.isClosed()
  } catch {
    session.closed = true
    return false
  }
}

async function disposeSession(session) {
  if (!session || session.closed) {
    return
  }

  session.closed = true
  try {
    await session.context.close()
  } catch {
    // Ignore close failures.
  }
}

async function settlePage(page, options = {}) {
  const navigationTimeoutMs = options.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS
  const domReadyTimeout = Math.min(navigationTimeoutMs, 10_000)
  await safeCall(() => page.waitForLoadState('domcontentloaded', { timeout: domReadyTimeout }), null)

  if (options.longWait) {
    await safeCall(() => page.waitForLoadState('networkidle', { timeout: Math.min(navigationTimeoutMs, 2_500) }), null)
  }

  await safeCall(() => page.waitForTimeout(350), null)
}

async function primeLocator(locator, timeoutMs) {
  await safeCall(() => locator.scrollIntoViewIfNeeded({ timeout: timeoutMs }), null)
  try {
    await locator.waitFor({ state: 'visible', timeout: Math.min(timeoutMs, 4_000) })
    return
  } catch {
    await locator.waitFor({ state: 'attached', timeout: Math.min(timeoutMs, 4_000) })
  }
}

function readLocatorTarget(params, name) {
  const target = {
    selector: readOptionalString(params.selector),
    text: readOptionalString(params.text),
    role: readOptionalString(params.role),
    name: readOptionalString(params.name),
    label: readOptionalString(params.label),
    placeholder: readOptionalString(params.placeholder),
    testId: readOptionalString(params.testId),
    exact: readOptionalBoolean(params.exact),
  }

  if (!hasLocatorTarget(target)) {
    throw new Error(`${name} must include at least one of selector, text, role, name, label, placeholder, or testId.`)
  }

  return target
}

function readOptionalSubmitTarget(params) {
  const target = {
    selector: readOptionalString(params.submitSelector),
    text: readOptionalString(params.submitText),
    role: readOptionalString(params.submitRole),
    name: readOptionalString(params.submitName),
    label: null,
    placeholder: null,
    testId: null,
    exact: false,
  }

  return hasLocatorTarget(target) ? target : null
}

function hasLocatorTarget(target) {
  return Boolean(target.selector || target.text || target.role || target.name || target.label || target.placeholder || target.testId)
}

async function resolveClickLocator(page, target, timeoutMs) {
  const candidates = []
  const exact = Boolean(target.exact)
  const nameOrText = target.name || target.text || null

  if (target.selector) {
    candidates.push(page.locator(target.selector).first())
  }
  if (target.testId) {
    candidates.push(page.getByTestId(target.testId).first())
  }
  if (target.label) {
    candidates.push(page.getByLabel(target.label, { exact }).first())
  }
  if (target.placeholder) {
    candidates.push(page.getByPlaceholder(target.placeholder, { exact }).first())
  }
  if (target.name) {
    candidates.push(page.locator(`[name="${escapeAttributeValue(target.name)}"]`).first())
  }
  if (target.role && nameOrText) {
    candidates.push(page.getByRole(target.role, { name: nameOrText, exact }).first())
  }
  if (target.role) {
    candidates.push(page.getByRole(target.role).first())
  }
  if (target.text) {
    candidates.push(page.getByRole('button', { name: target.text, exact }).first())
    candidates.push(page.getByRole('link', { name: target.text, exact }).first())
    candidates.push(page.getByText(target.text, { exact }).first())
  }
  if (target.name && !target.role) {
    candidates.push(page.getByRole('button', { name: target.name, exact }).first())
    candidates.push(page.getByRole('link', { name: target.name, exact }).first())
    candidates.push(page.getByText(target.name, { exact }).first())
  }

  return resolveFirstUsableLocator(candidates, timeoutMs, 'click target')
}

async function resolveFieldLocator(page, target, timeoutMs) {
  const candidates = []
  const exact = Boolean(target.exact)

  if (target.selector) {
    candidates.push(page.locator(target.selector).first())
  }
  if (target.testId) {
    candidates.push(page.getByTestId(target.testId).first())
  }
  if (target.label) {
    candidates.push(page.getByLabel(target.label, { exact }).first())
  }
  if (target.placeholder) {
    candidates.push(page.getByPlaceholder(target.placeholder, { exact }).first())
  }
  if (target.name) {
    candidates.push(page.locator(`[name="${escapeAttributeValue(target.name)}"]`).first())
  }
  if (target.role && (target.name || target.text)) {
    candidates.push(page.getByRole(target.role, { name: target.name || target.text, exact }).first())
  }
  if (target.text) {
    candidates.push(page.getByLabel(target.text, { exact }).first())
    candidates.push(page.getByPlaceholder(target.text, { exact }).first())
  }

  return resolveFirstUsableLocator(candidates, timeoutMs, 'form field')
}

async function resolveFirstUsableLocator(candidates, timeoutMs, label) {
  const lastErrors = []
  for (const locator of candidates) {
    if (!locator) {
      continue
    }

    try {
      await primeLocator(locator, timeoutMs)
      return locator
    } catch (error) {
      lastErrors.push(formatError(error))
      const count = await safeCall(() => locator.count(), 0)
      if (count > 0) {
        return locator
      }
    }
  }

  const detail = lastErrors.length > 0 ? ` Tried candidates: ${lastErrors.join(' | ')}` : ''
  throw new Error(`Could not resolve a usable ${label}.${detail}`)
}

async function resolveQuestionCardLocator(page, answer, timeoutMs) {
  const questionNumber = readOptionalNumber(answer.questionNumber)
  const questionText = readOptionalString(answer.questionText)
  if (questionNumber === null && !questionText) {
    throw new Error('Form answer requires questionNumber or questionText.')
  }

  const cards = page.locator('.question-card')
  const count = await safeCall(() => cards.count(), 0)
  const normalizedQuestionText = questionText ? normalizeVisibleText(questionText) : null

  for (let index = 0; index < count; index += 1) {
    const locator = cards.nth(index)
    const text = normalizeVisibleText(await safeCall(() => locator.innerText(), ''))
    if (!text) {
      continue
    }

    const matchesNumber = questionNumber !== null ? new RegExp(`^${escapeRegExp(String(questionNumber))}\\s*\\.`).test(text) : false
    const matchesText = normalizedQuestionText ? text.includes(normalizedQuestionText) : false

    if (matchesNumber || matchesText) {
      await primeLocator(locator, timeoutMs)
      return locator
    }
  }

  const candidates = []
  if (questionNumber !== null) {
    candidates.push(page.locator('.question-card').filter({ hasText: new RegExp(`^\\s*${escapeRegExp(String(questionNumber))}\\s*\\.`) }).first())
  }
  if (questionText) {
    candidates.push(page.locator('.question-card').filter({ hasText: questionText }).first())
  }

  return resolveFirstUsableLocator(candidates, timeoutMs, 'question card')
}

async function resolveQuestionOptionLocator(questionLocator, optionText, exact, timeoutMs) {
  const labels = questionLocator.locator('label')
  const count = await safeCall(() => labels.count(), 0)
  const target = normalizeVisibleText(optionText)

  for (let index = 0; index < count; index += 1) {
    const locator = labels.nth(index)
    const text = normalizeVisibleText(await safeCall(() => locator.innerText(), ''))
    if (!text) {
      continue
    }

    const matches = exact ? text === target : text.includes(target) || target.includes(text)
    if (matches) {
      return locator
    }
  }

  const candidates = [
    questionLocator.getByText(optionText, { exact }).first(),
    questionLocator.locator('label').filter({ hasText: optionText }).first(),
    questionLocator.locator('.form-input-choice').filter({ hasText: optionText }).first(),
  ]

  return resolveFirstUsableLocator(candidates, timeoutMs, 'question option')
}

async function clickQuestionOption(questionLocator, optionText, exact, timeoutMs) {
  await primeLocator(questionLocator, timeoutMs)
  const target = normalizeVisibleText(optionText)
  const clicked = await safeCall(
    () =>
      questionLocator.evaluate(
        (card, payload) => {
          const normalize = (value) => String(value || '').replace(/\s+/g, ' ').replace(/\u00a0/g, ' ').trim()
          const labels = Array.from(card.querySelectorAll('label'))
          const match = labels.find((label) => {
            const text = normalize(label.textContent)
            if (!text) {
              return false
            }

            return payload.exact ? text === payload.target : text.includes(payload.target) || payload.target.includes(text)
          })

          if (!match) {
            return false
          }

          match.scrollIntoView({ block: 'center', inline: 'center' })
          match.click()
          return true
        },
        { target, exact },
      ),
    false,
  )

  if (!clicked) {
    const optionLocator = await resolveQuestionOptionLocator(questionLocator, optionText, exact, timeoutMs)
    await primeLocator(optionLocator, timeoutMs)
    await optionLocator.click({ timeout: timeoutMs })
  }
}

async function resolveQuestionInputLocator(questionLocator, timeoutMs) {
  const candidates = [
    questionLocator.locator('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])').first(),
    questionLocator.locator('textarea').first(),
  ]

  return resolveFirstUsableLocator(candidates, timeoutMs, 'question input')
}

async function resolveSubmitLocator(page, submitText, timeoutMs) {
  const submitNames = [submitText, 'Отправить', 'Submit', 'Send'].filter(Boolean)
  const candidates = []

  for (const name of submitNames) {
    candidates.push(page.getByRole('button', { name, exact: true }).first())
    candidates.push(page.getByText(name, { exact: true }).first())
  }

  candidates.push(page.locator('button[type="submit"]').first())
  candidates.push(page.locator('button').filter({ hasText: /^(Отправить|Submit|Send)$/ }).first())

  return resolveFirstUsableLocator(candidates, timeoutMs, 'submit button')
}

async function extractFormQuestions(page) {
  return safeCall(
    () =>
      page.evaluate(() => {
        const clean = (value) => (value || '').replace(/\s+/g, ' ').trim()
        const cards = Array.from(document.querySelectorAll('.question-card, .question-card-wrapper'))
        const seen = new Set()
        const questions = []

        for (const card of cards) {
          const key = card.getAttribute('data-question-id') || clean(card.textContent).slice(0, 120)
          if (!key || seen.has(key)) {
            continue
          }
          seen.add(key)

          const fullText = clean(card.textContent)
          if (!fullText) {
            continue
          }

          const numberMatch = fullText.match(/^(\d+)\s*\./)
          const questionNumber = numberMatch ? Number.parseInt(numberMatch[1], 10) : null

          const optionLabels = Array.from(card.querySelectorAll('label .label-text, .form-input-choice .label-text'))
            .map((el) => clean(el.textContent))
            .filter(Boolean)

          const textInputs = Array.from(card.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([readonly]), textarea'))
            .map((input) => ({
              type: clean(input.getAttribute('type')) || input.tagName.toLowerCase(),
              name: clean(input.getAttribute('name')),
              id: clean(input.id),
            }))
            .filter((input) => input.name || input.id || input.type === 'number' || input.type === 'text' || input.type === 'textarea')

          let prompt = fullText
          for (const option of optionLabels) {
            if (option) {
              prompt = prompt.replace(option, ' ')
            }
          }
          prompt = clean(prompt)

          questions.push({
            number: questionNumber,
            prompt,
            type: optionLabels.length > 0 && textInputs.length > 0 ? 'mixed' : optionLabels.length > 0 ? 'choice' : 'text',
            options: optionLabels,
            textInputs,
          })
        }

        return questions
      }),
    [],
  )
}

async function describePage(page, options = {}) {
  const bodyText = await safeCall(() => page.locator('body').innerText({ timeout: 5_000 }), '')
  const title = await safeCall(() => page.title(), '')
  const interactive = options.includeInteractive
    ? await safeCall(
        () =>
          page.evaluate((limit) => {
            const limitItems = (items) => items.slice(0, limit)
            const clean = (value) => (value || '').replace(/\s+/g, ' ').trim()
            const selectorHint = (element) => {
              if (element.id) {
                return `#${element.id}`
              }
              const name = element.getAttribute('name')
              if (name) {
                return `[name="${name}"]`
              }
              const ariaLabel = clean(element.getAttribute('aria-label'))
              if (ariaLabel) {
                return `${element.tagName.toLowerCase()}[aria-label="${ariaLabel}"]`
              }
              return element.tagName.toLowerCase()
            }

            const links = limitItems(
              Array.from(document.querySelectorAll('a[href]')).map((element) => ({
                text: clean(element.textContent),
                href: element.href,
                role: clean(element.getAttribute('role')) || 'link',
                selectorHint: selectorHint(element),
              })),
            ).filter((item) => item.text || item.href)

            const buttons = limitItems(
              Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"]')).map((element) => ({
                text: clean(element.textContent || element.value || element.getAttribute('aria-label')),
                role: clean(element.getAttribute('role')) || 'button',
                name: clean(element.getAttribute('name')),
                selectorHint: selectorHint(element),
              })),
            ).filter((item) => item.text || item.name)

            const fields = limitItems(
              Array.from(document.querySelectorAll('input, textarea, select')).map((element) => {
                const labels = Array.from(element.labels || []).map((label) => clean(label.textContent)).filter(Boolean)
                return {
                  label: labels[0] || clean(element.getAttribute('aria-label')),
                  name: clean(element.getAttribute('name')),
                  placeholder: clean(element.getAttribute('placeholder')),
                  type: clean(element.getAttribute('type')) || element.tagName.toLowerCase(),
                  selectorHint: selectorHint(element),
                }
              }),
            ).filter((item) => item.label || item.name || item.placeholder)

            const headings = limitItems(
              Array.from(document.querySelectorAll('h1, h2, h3')).map((element) => clean(element.textContent)).filter(Boolean),
            )

            return { links, buttons, fields, headings }
          }, INTERACTION_SNAPSHOT_LIMIT),
        { links: [], buttons: [], fields: [], headings: [] },
      )
    : undefined
  const formQuestions = options.includeInteractive ? await extractFormQuestions(page) : undefined

  return {
    ok: true,
    url: page.url(),
    title,
    textPreview: bodyText.slice(0, 4_000),
    interactive,
    formQuestions,
  }
}

function resolveRuntimeConfig(rawConfig) {
  const config = asRecord(rawConfig)
  return {
    browserChannel: readOptionalString(config.browserChannel) || 'msedge',
    headless: readOptionalBoolean(config.headless) || false,
    userDataDir: readOptionalString(config.userDataDir) || DEFAULT_PROFILE_DIR,
    navigationTimeoutMs: readOptionalNumber(config.navigationTimeoutMs) || DEFAULT_NAVIGATION_TIMEOUT_MS,
    actionTimeoutMs: readOptionalNumber(config.actionTimeoutMs) || DEFAULT_ACTION_TIMEOUT_MS,
    viewportWidth: readOptionalNumber(config.viewportWidth) || DEFAULT_VIEWPORT_WIDTH,
    viewportHeight: readOptionalNumber(config.viewportHeight) || DEFAULT_VIEWPORT_HEIGHT,
  }
}

function getChannelCandidates(preferredChannel) {
  const candidates = [preferredChannel, 'msedge', 'chrome', 'chromium']
  return [...new Set(candidates.filter(Boolean))]
}

function loadPlaywright() {
  for (const nodeModulesPath of resolveRuntimeNodeModuleRoots()) {
    const packageJsonPath = path.join(nodeModulesPath, 'playwright-core', 'package.json')
    if (!existsSyncSafe(packageJsonPath)) {
      continue
    }

    const runtimeRequire = createRequire(packageJsonPath)
    return runtimeRequire('playwright-core')
  }

  throw new Error('playwright-core is not installed in the bundled Friday OpenClaw runtime.')
}

function resolveRuntimeNodeModuleRoots() {
  return [
    path.join(PLUGIN_DIR, '..', '..', 'vendor', 'openclaw-runtime', 'node_modules'),
    path.join(PLUGIN_DIR, '..', '..', 'openclaw-runtime', 'node_modules'),
  ]
}

function existsSyncSafe(targetPath) {
  return existsSync(targetPath)
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function readRequiredString(value, name) {
  if (typeof value === 'string' && value.trim()) {
    return value.trim()
  }

  throw new Error(`${name} must be a non-empty string.`)
}

function readOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readOptionalBoolean(value) {
  return typeof value === 'boolean' ? value : false
}

function readOptionalNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function escapeAttributeValue(value) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizeVisibleText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\u00a0/g, ' ')
    .trim()
}

function toolJson(value) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(value, null, 2),
      },
    ],
  }
}

async function safeCall(factory, fallbackValue) {
  try {
    return await factory()
  } catch {
    return fallbackValue
  }
}

function formatError(error) {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}
