# Contributing

Foreman's own development follows the same discipline its runtime enforces.

## The rules

1. **No direct pushes to main.** Every change lands as a PR.
2. **Every PR is reviewed by Qodo** (GitHub app, runs automatically).
3. **Every Qodo finding is resolved in public**: either fixed with a
   regression test, or dismissed with a written rationale in the PR.
4. `npm test` must be green before you push and after every merge.
5. T2-classified changes to the harness itself (policy engine, approval gate,
   audit log) require a second reviewer in addition to Qodo.

## Workflow

```bash
git checkout -b feat/your-change main
# ... make the change + tests ...
npm test
git push -u origin feat/your-change
gh pr create --fill
# wait for Qodo review → address findings → merge
```

## Commit style

Conventional commits (`feat:`, `fix:`, `test:`, `chore:`, `docs:`) — scope in
parens when useful: `fix(gate): ...`.
