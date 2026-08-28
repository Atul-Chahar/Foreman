# Foreman progress

Last validated: 2026-08-27 (Asia/Kolkata)

## Completed

- Durable T0/T1/T2 policy and human approval gates.
- Local deterministic backend with policy-authorized branch and commit writes.
- CLI approval wait lifecycle fixed: a pending decision keeps the process alive.
- TrueForge execution connected to the installed local API.
  - Supports both `data`-wrapped JSON and streamed SSE turn responses.
  - Uses the configured `provider/model` name returned by `GET /api/v1/models`.
  - Requires a strict, fail-closed file envelope from the model.
  - Rejects malformed, duplicate, absolute, and traversing paths.
  - Routes branch and commit operations through the same T1 policy bridge.
  - Runs target-repository tests in a disposable worktree after committing.
- Active backend is printed at CLI startup.
- TrueForge smoke command and opt-in live integration tests added.
- Plaintext NVIDIA credential removed from the local handoff document.

## Validation evidence

```text
npm test
118 tests: 116 passed, 2 live tests skipped, 0 failed

npm run trueforge:smoke
session -> streamed turn -> done -> valid smoke.txt envelope

npm run test:trueforge
2 passed: live protocol + authorized commit/test on a scratch branch
```

The full suite must be run on the host because the managed coding sandbox
intentionally interferes with descendant stdin/stdout used by the MCP and
worktree-runner tests.

## Remaining release operations

- Rotate the NVIDIA key that previously appeared in `HANDOFF.md`.
- Commit/push the current branch and open the Qodo-reviewed PR(s).
- Record and upload the demo video.
- Only perform timestamp history rewriting if still required, after explicit
  confirmation and a verified backup; it is intentionally not automated.
