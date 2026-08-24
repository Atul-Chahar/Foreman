---
name: build-fix
description: Diagnose from the failing output, isolate, apply the minimal fix, re-run — never widen the blast radius.
tags: competency
---

Fixing a broken build, in order:

1. Read the failure output tail. The failing test name and the first
   assertion error are the diagnosis; everything above them is context.
2. Isolate: run only the failing test. Confirm it fails alone, the same
   way.
3. Understand why before touching anything. A test that broke after
   someone else's merge usually means your assumption changed, not their
   code is wrong.
4. Apply the minimal fix: prefer a revert of the culprit to a clever
   patch; prefer changing one line to restructuring a module. The goal is
   a green main, not a better architecture.
5. Re-run the whole suite, not just the failing test. Your fix must not
   break a neighbor.
6. Two failed attempts means stop and escalate to a human. A third
   attempt at the same failure is a loop, not persistence.
