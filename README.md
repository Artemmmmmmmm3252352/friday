# Friday

Friday is a Windows desktop AI agent that combines local computer automation with
an authenticated ecosystem data context. It can help with everyday desktop work,
use Windows applications and files, and work with a user's notes, tasks, projects,
documents, and other ecosystem data through controlled tools.

The agent runs locally through OpenClaw. Server data is synchronized into a local
snapshot for fast contextual answers, while mutations are sent through authenticated
backend actions. This keeps ordinary desktop workflows local without giving the model
direct database access.

## Highlights

- Local Windows automation for applications, files, browser workflows, and routine work
- OpenClaw-based reasoning and tool execution
- Authenticated synchronization of user notes, tasks, projects, documents, and memory
- Controlled ecosystem mutations with confirmation for destructive actions
- Telegram remote control with one-time pairing
- Voice input and speech synthesis
- Bundled-runtime Windows installer for fresh devices

## Architecture

```text
Desktop UI (Electron + React)
        |
Electron main process
        |
        +-- Local OpenClaw runtime -> Windows/browser/file tools
        |
        +-- Local user-data snapshot <- authenticated ecosystem sync
        |
        +-- Authenticated actions -> ecosystem backend
```

The repository contains the desktop client, local API/worker packages, OpenClaw
plugins, and build scripts. Large generated runtimes, model files, installers,
credentials, sessions, and local state are intentionally excluded from Git.

## Development

### Requirements

- Windows 10 or 11
- Node.js 22+
- npm

### Start

```powershell
npm install
Copy-Item .env.example .env.local
npm run dev:desktop
```

Populate `.env.local` only with credentials for your own development environment.
Never commit it.

### Verify

```powershell
npm test
npm run build:desktop
```

### Build the Windows installer

The release build prepares sanitized OpenClaw, backend, voice, and portable Python
runtime assets before packaging:

```powershell
npm run build:installer
```

Generated installers and runtime assets are excluded from the repository.

## Safety

- The backend derives the current user from the authenticated session.
- The model does not receive direct database credentials.
- Destructive ecosystem actions require confirmation.
- Telegram remote commands are accepted only from paired users.
- Secrets, local sessions, generated runtimes, and user snapshots must never be committed.

Please read [SECURITY.md](SECURITY.md) before reporting a vulnerability. Contributions
are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md) for the development and review flow.

## Status

Friday is under active development. Interfaces and runtime packaging may change
while the desktop agent and ecosystem integrations are stabilized.

## License

MIT. See [LICENSE](LICENSE).
