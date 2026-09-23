# ASF worker configuration example

`production-mode.json` is a schema-valid starting point for the explicit `asf-worker` service
doctor. It contains no credentials. Before you use it, replace every `replace-with-*` value and
adjust the private Unix endpoints for your host.

The file is configuration and nothing more. It does not come with a ctxlane service, credentials,
a provider harness, a sandbox, GitHub permissions, or an executable worker composition. `runmill service
doctor --config production-mode.json` refuses this sample until you supply an explicit readiness
observation, and `runmill service start --mode asf-worker` still needs a composition module that
the operator owns. A passing doctor report counts as evidence. It does not grant
`productionQualified` authority.

Standalone Runmill never reads this directory and needs no ASF configuration.
