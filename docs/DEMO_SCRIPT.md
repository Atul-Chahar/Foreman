# Foreman demo runbook

Target length: 3–4 minutes.

## Before recording

1. Rotate the previously exposed NVIDIA key and confirm TrueForge is running.
2. Confirm `.env` contains the local URL and the model name reported by
   `GET http://localhost:8790/api/v1/models`.
3. Run:

   ```bash
   npm test
   npm run trueforge:smoke
   ```

4. If old demo state is disposable, reset it deliberately:

   ```bash
   node scripts/seed.mjs --reset
   ```

## Recording flow

### 0:00–0:30 — Problem and promise

Show the README title and explain: agents work in parallel, but irreversible
actions cannot bypass a durable human decision.

### 0:30–1:00 — Start the real backend

In terminal 1:

```bash
node harness/cli.mjs demo
```

Point out the startup line containing `backend=trueforge` and the bounded
parallel task dispatch.

### 1:00–2:15 — Human supervision

In terminal 2:

```bash
node harness/cli.mjs approvals
node harness/cli.mjs approve appr-0001 --reason "generated files reviewed"
```

Show that the first process remains alive, the decision includes an actor and
reason, and the pipeline resumes from durable SQLite state. Repeat for the PR
and T2 merge prompts. Emphasize that T2 has no auto-approval configuration.

### 2:15–2:50 — Evidence and recovery

Show the run summary, then:

```bash
tail -n 8 evidence/audit.log
node harness/cli.mjs status
```

Mention serialized merges, post-merge health checks, and bounded reconciler
fix rounds.

### 2:50–3:30 — Technical proof

Show the TrueForge live test and the Qodo review links in the README:

```bash
npm run test:trueforge
```

Close with the invariant: TrueForge generates; Foreman validates, gates,
commits, tests, and only then offers the merge to a human.
