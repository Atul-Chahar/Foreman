---
name: context-budget
description: Token discipline for subagents — ask for listed context only, summarize instead of dumping, never request the repo tree.
tags: competency
---

Every token in your prompt is a cost paid by every parallel agent:

1. Work from the spec block. It already contains the acceptance criteria,
   the scope, and the context file paths. That is your world; do not ask
   for the repository tree.
2. Read only the files the spec lists. If you truly need one more, read
   that one file — not its whole directory.
3. Quote code by path and line range, not by pasting whole files back.
4. Summarize what you learned before acting on it; the summary is your
   working memory and it costs a fraction of the source.
5. Never paste logs, diffs, or test output wholesale — tail them to the
   relevant part.
6. If a task genuinely cannot be done within this budget, say so in your
   result instead of improvising scope.
