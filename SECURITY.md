# Security Policy

## Supported versions

Friday is under active development. Security fixes are applied to the latest version
on the `main` branch.

## Reporting a vulnerability

Please do not open a public issue containing vulnerability details, credentials, or
user data. Contact the maintainer privately through the email associated with the
GitHub profile and include:

- the affected component and version or commit;
- reproduction steps;
- the expected and observed behavior;
- the potential impact;
- a suggested mitigation, if available.

Please allow reasonable time for investigation and remediation before disclosure.

## Security boundaries

Friday treats the following as high-risk areas:

- desktop, browser, file, VPN, and remote-control tools;
- authenticated ecosystem data actions;
- destructive or irreversible operations;
- secrets and local agent/session state;
- bundled runtime and installer supply chain.

Destructive ecosystem actions require confirmation, and backend identity must be
derived from the authenticated session rather than model-provided input.
