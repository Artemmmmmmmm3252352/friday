# Contributing to Friday

Friday combines desktop automation, authenticated data access, and local agent
execution. Changes can affect user files, credentials, or system actions, so every
contribution should preserve clear safety boundaries.

## Before opening a pull request

1. Create a focused branch and keep the change narrowly scoped.
2. Never commit credentials, user snapshots, local OpenClaw profiles, generated
   runtimes, installers, or model files.
3. Add or update tests for changed behavior.
4. Run the required checks:

```powershell
npm install
npm test
npm run build:desktop
```

## Pull request expectations

- Explain the user-facing behavior and why the change is needed.
- Describe security implications for tools, authentication, remote control, and files.
- Include verification steps and relevant screenshots for UI changes.
- Keep destructive actions behind an explicit confirmation boundary.
- Derive ecosystem user identity only from the authenticated backend session.

## Reporting security issues

Do not disclose vulnerabilities or credentials in public issues. Follow
[SECURITY.md](SECURITY.md) instead.
