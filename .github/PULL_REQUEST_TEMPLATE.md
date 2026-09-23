## What changed

<!-- Describe the problem and the behavior after this change. -->

## Safety review

- [ ] This change does not alter authority or irreversible effects.
- [ ] If it does, I described the new authority, who owns it, and how it fails closed below.
- [ ] I listed any risk-sensitive paths this touches (`workspace`, `credentials`, `orchestrator`, `pr`,
      state migrations, configuration policy, or workflows).
- [ ] Where a safety gate changed, I added or updated a negative/refusal test.
- [ ] I considered both macOS Seatbelt and Linux bubblewrap behavior, or marked one not applicable.
- [ ] Verification and review still apply to the exact candidate commit.

Authority or risk notes:

<!-- Write "None" when this is not authority-sensitive. -->

## Verification

Exact commands run:

```text
npm run check
```

- [ ] Docs are updated wherever behavior or support changed.
- [ ] Generated error documentation is current (`npm run docs:check`).
- [ ] Package smoke passes (`npm run package:check`) when packaging or CLI entrypoints changed.
- [ ] No live credentials or remotes were used, or I documented the live test scope and cleanup.
