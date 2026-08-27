# Foreman

**A supervised swarm coding harness.** Foreman takes an issue backlog and runs a
bounded swarm of AI implementer agents over it — in parallel, on isolated
branches, inside sandboxes — while *every irreversible action stops at a human
approval gate*. Parallel speed, serial safety.

Built for the [Agent Harness Hackathon](https://www.wemakedevs.org/hackathons/trueforge)
(Aug 24–30, 2026) on top of **TrueForge**, TrueFoundry's open-source agent harness.

---

## Why

AI coding agents are fast and unaccountable. Foreman's thesis: the missing piece
is not a smarter model, it's a **supervision layer with teeth** —

- a risk-tier policy engine where dangerous actions are *structurally* incapable
  of sneaking through (T2 auto-approval is a compile-time `false`, not a config flag),
- durable state (SQLite) so a crashed run resumes instead of orphaning work,
- an append-only audit log so every decision — human or policy — is reconstructible,
- parallel agents whose output integrates through one verified, serialized merge queue,
- a self-healing reconciler that dispatches bulkheaded fix agents when main breaks.

## Quickstart

```bash
npm install

# zero credentials needed — local-git backend, offline by default
node harness/cli.mjs demo          # seeds a demo repo + backlog and runs the swarm
node harness/cli.mjs status        # what is the swarm doing right now?
node harness/cli.mjs approvals     # what is waiting for ME?
node harness/cli.mjs approve appr-0001 --reason "tests pass"
node harness/cli.mjs killswitch engage   # freeze everything, instantly
```

For the real TrueForge demo, start the local TrueForge server first and set
the three `FOREMAN_TRUEFORGE_*` values in `.env`. Then use two terminals:

```bash
# terminal 1 — stays alive at each durable gate
node harness/cli.mjs demo

# terminal 2 — inspect and decide; each decision re-drives the pipeline
node harness/cli.mjs approvals
node harness/cli.mjs approve appr-0001 --reason "reviewed generated files"
```

Run against your own GitHub repo:

```bash
cp .env.example .env   # then set FOREMAN_TARGET_GITHUB=owner/repo and tokens
node harness/cli.mjs run
```

## Architecture

```
issues ──▶ Planner ──▶ Dispatcher ──▶ Review stage ──▶ Merge queue ──▶ main
            │              │              │                  │            │
       structured      bounded swarm   heuristic          serialized,  Reconciler
       specs, risk     of implementer  pre-PR review:     rebase-tested, self-heals
       tiers, conflict  agents in      secrets/injection/ T2 approval   broken main via
       graph           isolated        scope checks       gate ALWAYS   bulkheaded fix
                       sandboxes                          before merge  agents
```

| Stage | Module | Guarantee |
|---|---|---|
| State | `harness/core/store.mjs` | SQLite; survives restarts; transitions audited in-transaction |
| Policy | `harness/policy/engine.mjs` | T0 read-only · T1 opt-in writes · **T2 hard-gated** |
| Gate | `harness/gate/approval_gate.mjs` | Durable pending approvals; kill-switch-aware; race-safe decisions |
| Planner | `harness/planner/spec_enhancer.mjs` | Raw issue → structured spec (scope, criteria, conflicts, tier) |
| Dispatcher | `harness/subagents/dispatcher.mjs` | Bounded concurrency, conflict locks, abortable timeouts |
| Backends | `harness/subagents/backends.mjs` | **TrueForge sessions** (primary) / deterministic local fallback |
| Reviewer | `harness/reviewer.mjs` | Fail-closed heuristics before a PR can even open |
| Merge queue | `harness/merge_queue.mjs` | One merge at a time, rebase-retested, crash-recoverable |
| Reconciler | `harness/reconciler.mjs` | Bulkheaded fix rounds; escalates instead of looping |

## The safety model (T0/T1/T2)

| Tier | Examples | Behavior |
|---|---|---|
| **T0** | read issues, read files, diffs | auto-approved, always visible in the audit log |
| **T1** | create branch, commit to task branch, open PR | gated by default; a human may opt into auto per-run |
| **T2** | merge to main, close issue, force push | **hard-gated. There is no code path, flag, or env var that auto-approves T2** (`T2_AUTO_APPROVABLE === false`) |

Plus a global kill switch: engaging it refuses all new gated work instantly;
approvals granted mid-freeze are recorded but their execution waits for release.
Every decision lands in SQLite **and** a JSONL evidence file, reconciled by id.

## TrueForge: the execution core

Foreman's implementer agents are **TrueForge sessions**, not homegrown loops:

- Each task creates a TrueForge session whose agent spec runs sandboxed
  (`config.sandbox.enabled`) — agent-written code never executes on the orchestrator host.
- Task prompts are delivered as turns over the documented REST protocol
  (`POST /api/v1/sessions` → `POST /sessions/:id/turns` → turn polling), with
  skill-driven prompt composition (role + competencies + spec block).
- Sensitive actions ride TrueForge's own tool-approval pauses; Foreman's gate
  bridges them to the human console.
- The deterministic local backend exists for offline dev/CI only, and is
  refused at construction time unless it is given a policy bridge.

Configure with `FOREMAN_TRUEFORGE_URL` / `FOREMAN_TRUEFORGE_TOKEN` /
`FOREMAN_TRUEFORGE_MODEL`.

```bash
# Validate the configured local TrueForge server without touching a repo
npm run trueforge:smoke

# Opt-in live integration test (creates one session and one turn)
npm run test:trueforge
```

Completed turns must return a strict
`{"files":[{"path":"src/x.mjs","content":"complete contents"}]}` envelope.
Foreman sanitizes every relative path, routes branch and commit operations
through the same T1 approval bridge as the local backend, commits through its
GitHub/local-git facade, and only reports success after the target repository's
sandboxed test command passes. Model output therefore cannot bypass policy or
write directly to the host checkout.

## Qodo Code Review Evidence

Per hackathon rules, **every** substantive change landed through a PR reviewed
by [Qodo](https://www.qodo.ai/) (GitHub app). Reviews were not rubber stamps:
Qodo raised **50+ findings across the series** (state-machine bypasses, race
conditions, path traversal, injection false positives, fail-open error paths),
each fixed with regression tests or dismissed with a public written rationale.

| PR | Scope | Review trail |
|---|---|---|
| [#10 Core foundation](https://github.com/Atul-Chahar/Foreman/pull/10) | state machine, store, audit, policy, gate | 11 bugs found → fixed → incremental re-review found 10 more (incl. transactional-validation and audit-divergence races) → fixed with dispositions |
| [#11 MCP layer](https://github.com/Atul-Chahar/Foreman/pull/11) | GitHub tools, local-git backend, MCP client, rate limiter | 9 bugs + 2 insights: gated merges, schema translation, atomic batch commits, symlink escape (found via test), typed transport retries |
| [#12 Planner + sandbox](https://github.com/Atul-Chahar/Foreman/pull/12) | spec enhancer, worktree runner | 9 findings: process-group kills, allowlist tightening, migration→T2 |
| [#13 Dispatcher](https://github.com/Atul-Chahar/Foreman/pull/13) | bounded swarm, backends | Gated local backend, TrueForge session/turn protocol, abortable timeouts |
| [#14 Queue + reconciler](https://github.com/Atul-Chahar/Foreman/pull/14) | serial integration, self-healing | Durable locks, crash recovery, merge-order culprit, legal fix-round transitions |
| [#15 Skills + reviewer](https://github.com/Atul-Chahar/Foreman/pull/15) | SKILL.md registry, review stage | Fail-closed review crashes, real diff line numbers, precise injection heuristic |
| [#16 Orchestrator + CLI](https://github.com/Atul-Chahar/Foreman/pull/16) | run loop, console | End-to-end tests exposed 3 real integration gaps (missing policy bridge, unregistered action, wedged lock) — fixed |
| [#17 Repo hygiene](https://github.com/Atul-Chahar/Foreman/pull/17) | seed script, vendored skills | Reset semantics, no scannable credential literals |

Sample inline review threads:
[approval-gate race](https://github.com/Atul-Chahar/Foreman/pull/10#discussion_r3858408657),
[gated merge facade](https://github.com/Atul-Chahar/Foreman/pull/11#discussion_r),
[symlink escape test](https://github.com/Atul-Chahar/Foreman/pull/11/files#r).

## Testing

```bash
npm test    # node:test, zero dependencies
```

118 tests across unit and integration levels (116 default-pass + 2 opt-in
TrueForge live tests), including:

- full pipeline on a real scratch git repo (issue → swarm → review → gate → merge),
- restart durability (approvals, locks, stranded-merge recovery),
- security regression tests (path traversal incl. dangling symlinks, secret scanning,
  injection heuristics, spend-cap edges, kill-switch semantics).
- TrueForge protocol, output-envelope, gated materialization, and opt-in live coverage.

## Repository layout

```
harness/
  cli.mjs              foreman CLI (run/resume/status/approve/reject/killswitch)
  orchestrator.mjs     wires everything into the supervised run loop
  core/                store, state machine, events, audit, ids, spend meter
  policy/              risk-tier engine (T2 unconditionally gated)
  gate/                human approval gate
  planner/             spec enhancer + conflict graph
  subagents/           dispatcher + TrueForge/local backends
  mcp_clients/         MCP client, rate limiter, GitHub/local-git backends
  skills/              SKILL.md loader and registry
scripts/seed.mjs       offline demo bootstrap
.agents/skills/        vendored Qodo skills used as this repo's own quality gates
```

## License

MIT — see [LICENSE](LICENSE).
