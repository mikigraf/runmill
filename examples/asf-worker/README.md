# ASF worker configuration example

`production-mode.json` is a schema-valid, credential-free starting point for the explicit
`asf-worker` service doctor. Replace every `replace-with-*` value and adjust the private Unix
endpoints for the host before using it.

This file is configuration only. It does not ship a ctxlane service, credentials, a provider
harness, a sandbox, GitHub permissions, or an executable worker composition. `runmill service
doctor --config production-mode.json` refuses this sample until an explicit readiness observation
is supplied, and `runmill service start --mode asf-worker` still requires an operator-owned
composition module. A passing doctor report is evidence, not `productionQualified` authority.

Standalone Runmill does not read this directory or require any ASF configuration.
