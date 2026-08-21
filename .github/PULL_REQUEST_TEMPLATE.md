## What changed

<!-- Describe the problem and the behavior after this change. -->

## Safety review

- [ ] This change does not alter authority or irreversible effects.
- [ ] If it does, I described the new authority, its owner, and its fail-closed behavior below.
- [ ] I identified risk-sensitive paths touched (`workspace`, `credentials`, `orchestrator`, `pr`,
      state migrations, configuration policy, or workflows).
- [ ] I added or updated a negative/refusal test where a safety gate changed.
- [ ] I considered both macOS Seatbelt and Linux bubblewrap behavior, or marked one not applicable.
- [ ] Verification and review still apply to the exact candidate commit.

Authority or risk notes:

<!-- Write "None" when this is not authority-sensitive. -->

## Verification

Exact commands run:

```text
npm run check
```

- [ ] Documentation is updated where behavior or support changed.
- [ ] Generated error documentation is current (`npm run docs:check`).
- [ ] Package smoke passes (`npm run package:check`) when packaging or CLI entrypoints changed.
- [ ] Live credentials or remotes were not used, or the live test scope and cleanup are documented.
