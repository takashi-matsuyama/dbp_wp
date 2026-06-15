# Security Policy

DBP WP is a local-first app that runs on the user's own machine and connects to their
WordPress site over the REST API. This policy covers the DBP WP packages (`dbp-wp`,
`@dbp-wp/core`, `@dbp-wp/ui`) and the DBP WP Connector plugin in this repository.

## Reporting a Vulnerability

Please **do not open a public GitHub issue** for security vulnerabilities. Use GitHub
Private Vulnerability Reporting (PVR):

> https://github.com/takashi-matsuyama/dbp_wp/security/advisories/new

Include a description and impact, steps to reproduce, the affected package(s)/file(s),
and (optionally) a suggested fix.

### Response timeline

- Acknowledgement: within 7 days
- Initial assessment: within 14 days
- Fix or mitigation: depends on severity

We follow coordinated disclosure and credit reporters unless they prefer anonymity.

## Scope

In scope: the DBP WP packages (`dbp-wp` CLI/local server, `@dbp-wp/core`, `@dbp-wp/ui`)
and the DBP WP Connector plugin — e.g. credential exposure, the local server being
reachable cross-origin or by other machines, formula-engine sandbox escapes, REST path
traversal, or connector privilege issues.

Out of scope: the user's own WordPress install, hosting, or third-party plugins;
WordPress core; and attacks requiring a malicious local user already on the machine.

## Supported versions

DBP WP is pre-1.0; security fixes target the latest commit on `main`.
