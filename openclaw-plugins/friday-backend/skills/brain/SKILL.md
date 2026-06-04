---
name: brain
version: 1.3.1-friday
description: Persistent 2nd-brain knowledge base for Friday memory about people, places, games, tech, events, media, ideas, and organizations.
permissions:
  write: true
---

# Brain Skill - 2nd Brain Knowledge Base

This is a Friday-adapted variant of the public `2nd-brain` skill from ClawHub.

## Friday Integration

Friday exposes built-in memory tools through the Friday Backend plugin:

- `friday_memory_search`
- `friday_memory_get`
- `friday_memory_remember`
- `friday_memory_list`

Use these tools instead of filesystem-based `memory_search` and `memory_get`.

## When To Use

Use this skill when the user:

- asks you to remember a person, place, device, game, event, company, media item, or idea
- asks what you already know about a named entity
- asks a cross-chat question about the user such as `Как меня зовут?`, `Что я люблю?`, `Что ты помнишь обо мне?`, or `Где я работаю?`
- corrects or updates previously stored knowledge
- shares a preference tied to a named entity

Do not leave durable named-entity facts only in temporary chat context.
Do not answer "I do not know" about a durable user fact until you checked Friday memory first.

## Categories

- `people`
- `places`
- `games`
- `tech`
- `events`
- `media`
- `ideas`
- `orgs`

## Workflow

1. Search first with `friday_memory_search`.
2. If there is an exact match, read it with `friday_memory_get`.
3. Update carefully with `friday_memory_remember`.
4. If there is no match, create a new entry with `friday_memory_remember`.
5. If there are multiple possible matches, ask one short clarification question.

For self-referential recall questions in a new chat, start with memory lookup before asking the user to repeat themselves.

## Remembering Rules

- Prefer one memory per named entity.
- Keep titles stable and human-readable.
- Put the quick recall sentence in `summary`.
- Put richer facts, context, dates, and preferences in `content`.
- Use `aliases` for nicknames and alternate spellings.
- Use `links` for explicit relationships such as `people/artem` or `orgs/x-vexta`.

## Templates

Templates live in `skills/brain/templates/` and guide the shape of new memories:

- `person.md`
- `place.md`
- `game.md`
- `tech.md`
- `event.md`
- `media.md`
- `idea.md`
- `org.md`

## Example

User: "Запомни, что Артём любит flat white в Skuratov и работает в X-VEXTA."

Agent:

1. `friday_memory_search` for `Артём`
2. if no exact match, create a `people` memory
3. store a short summary plus richer details
4. link `orgs/x-vexta` if relevant
