---
name: playwright-browser
description: Use Playwright browser automation tools when the user needs a real browser session with DOM control, form filling, clicking, or page extraction.
---

Use the Playwright browser tools for tasks that need a real interactive browser instead of a simple web fetch.

Prefer these tools when the user wants to:

- open a site and continue working inside the same browser session
- click buttons, links, tabs, or menu items
- fill login, search, checkout, or other web forms
- wait for dynamic content and then read or parse the result
- extract structured page data after navigation

Recommended flow:

1. Start with `playwright_browser_open`.
2. Inspect the current page with `playwright_browser_snapshot` if you need to understand what is visible.
3. For quizzes, surveys, and tests, prefer `playwright_browser_form_snapshot` to see grouped questions and answer options.
4. Use `playwright_browser_form_answer` when you need to answer specific questions inside a structured form.
5. Use `playwright_browser_click` and `playwright_browser_fill_form` for general interaction outside grouped forms.
6. Use `playwright_browser_extract` to return the final data or text the user asked for.
7. Use `playwright_browser_close` when the browser session is no longer needed.

Rules:

- Prefer Playwright tools over the built-in browser tool when the user explicitly asks for browser control or when the page is interactive.
- These tools open a separate managed browser window. They do not take over an already-open human Chrome tab.
- Prefer label, text, placeholder, name, or role-based targets before raw CSS selectors.
- For quizzes and tests, do not echo raw tool JSON to the user. Summarize progress and final result in plain language.
- Keep selectors specific and stable when possible.
- Do not claim an action succeeded unless the tool call actually succeeded.
- If a page changes after a click or submit, take a fresh snapshot before the next step.
