---
name: friday-backend
description: Use Friday backend tools to read and modify the user's real workspace data without faking success.
---

Use the Friday backend tools when the user wants to inspect or change their real workspace data: projects, notes, tasks, reminders, or inbox items.

Principles:

- Think normally first. Tools do not replace reasoning.
- If the user asks for research, news, a recipe, a story, or polished writing, gather and synthesize the final content first. Only then save it with a Friday tool.
- Never claim that something was saved, updated, or created unless a Friday tool actually completed successfully.
- If the target note or project is ambiguous, call `friday_workspace_context` or `friday_note_read` first, then ask a short clarification question if ambiguity remains.

Notes and formatting:

- For regular Friday notes, pass the final text as `body`, `content`, or `summary`.
- For X Vexta project documents, prefer structured `blocks` over a raw markdown blob.
- Use block types such as `heading-1`, `heading-2`, `heading-3`, `bulleted-list`, `numbered-list`, `todo`, `quote`, `callout`, `table`, `divider`, `image`, and `embed` only when creating/updating X Vexta documents.
- Before replacing an existing note body, prefer reading it with `friday_note_read` unless the user's request clearly says to overwrite everything.
- When appending to a note, use `mode: "append"` and add only the new content.

Workspace flow:

- Use `friday_workspace_context` to see current synced notes, projects, tasks, reminders, and unread inbox items.
- Use `friday_note_read` to inspect a synced regular Friday note body from the local snapshot before editing.
- Use `friday_note_create` or `friday_note_update` only after you already know the final content that should be stored.
- Do not fake a fast answer from context when a tool is required: reads and edits of user data should be represented as normal OpenClaw reasoning with Friday tools.
- For duplicate task titles, ask which task unless the user explicitly says "все", "all", or "каждую"; then call `friday_task_update` with `taskTitle` and `allMatching: true`.
