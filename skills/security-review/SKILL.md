---
name: security-review
description: A precision-first checklist applied to every diff — secrets, dynamic execution, injection, deserialization, authz.
tags: competency
---

Check every changed line against this list. Flag only what you can point
at; false positives stall a parallel swarm.

1. Secrets: hardcoded tokens (GitHub PATs, provider API keys, AWS key
   IDs), private key blocks, credentials in URLs, secrets committed "just
   for the demo". All blocking.
2. Dynamic execution: eval(...), new Function(...), vm.runInNewContext
   with non-literal input, deserialization of untrusted data into code.
   All blocking.
3. Injection: commands, SQL, or shell invocations built by concatenating
   or interpolating untrusted values. Parameterize instead. Blocking.
4. Unsafe deserialization: parsing untrusted input into objects that then
   execute or eval (yaml with code tags, template engines running raw
   user input). Blocking.
5. Access control: an endpoint or function the spec implied would be
   protected but the diff leaves open. Blocking only when the spec clearly
   promised protection.
6. Hygiene (warnings): TODO/FIXME left in the diff, debug output enabled,
   new source file with no accompanying test.
