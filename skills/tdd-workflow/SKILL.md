---
name: tdd-workflow
description: Red, green, refactor — the failing test comes first and the spec's test command is the arbiter.
tags: competency
---

Test-driven discipline for every implementation task:

1. RED — write a test that expresses one acceptance criterion and watch it
   fail for the right reason (not a syntax error).
2. GREEN — write the smallest code that makes that test pass. Smallest
   means smallest, not "reasonable-looking".
3. REFACTOR — clean up with the test still green, in the same task.
4. One criterion at a time. Repeat until every acceptance criterion has a
   test that passes.
5. The spec's test command is the arbiter of done — not your confidence.
   Run it before you claim anything.
6. Never delete or skip a failing test to go green. If a criterion is
   wrong, report it instead of working around it.
