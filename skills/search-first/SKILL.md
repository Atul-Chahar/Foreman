---
name: search-first
description: Read what exists before writing anything new — extend, don't duplicate.
tags: competency
---

Before writing code, search:

1. Read every file in the spec's context list. The helper you are about to
   write often already exists two imports away.
2. Search the module for the nouns in the task title. An existing
   function, route, or schema is usually the right place to extend.
3. Prefer extending an existing module over creating a new one; prefer
   deleting code over adding abstractions.
4. If two implementations of the same idea would exist after your change,
   you are doing it wrong — consolidate instead.
5. Only create a new file when the spec's scope names it, or when nothing
   existing can hold the change without being distorted.
