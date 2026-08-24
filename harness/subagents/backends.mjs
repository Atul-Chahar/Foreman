// Execution backends for implementer subagents.
//
//   TrueForgeBackend — the real thing: dispatches the task to a TrueForge
//     subagent session (FOREMAN_TRUEFORGE_URL). The agent reads the spec,
//     writes code, runs tests in TrueForge's sandbox, and returns the result.
//
//   LocalBackend — the deterministic fallback: executes the spec directly
//     (structured `impl` files + generated test scaffolding) against the
//     target repo over MCP. No credentials required; used for offline runs,
//     CI, and the seeded demo. Same lifecycle, same gates, same events —
//     only the "brain" differs.

export class TrueForgeBackend {
  constructor({ config, fetchImpl = globalThis.fetch }) {
    this.url = config.trueforgeUrl;
    this.token = config.trueforgeToken;
    this.fetch = fetchImpl;
  }

  get name() { return 'trueforge'; }

  async run({ spec, branch, skill = 'implementer' }) {
    const res = await this.fetch(`${this.url}/api/v1/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify({
        role: skill,
        prompt: buildPrompt(spec),
        metadata: {
          task_id: spec.id,
          branch,
          acceptance_criteria: spec.acceptance_criteria,
          test_command: spec.test_command,
        },
        sandbox: true, // agent code must run inside TrueForge's sandbox
      }),
    });
    if (!res.ok) throw new Error(`trueforge dispatch failed: ${res.status} ${await res.text()}`);
    const session = await res.json();
    // Poll until the session resolves (TrueForge notifies completion).
    return this.awaitResult(session.id);
  }

  async awaitResult(sessionId, { pollMs = 2000, maxMs = 600_000 } = {}) {
    const deadline = Date.now() + maxMs;
    for (;;) {
      const res = await this.fetch(`${this.url}/api/v1/sessions/${sessionId}`, {
        headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
      });
      if (!res.ok) throw new Error(`trueforge poll failed: ${res.status}`);
      const s = await res.json();
      if (s.status === 'completed' || s.status === 'failed' || s.status === 'timeout') return s;
      if (Date.now() > deadline) throw new Error(`trueforge session ${sessionId} exceeded ${maxMs}ms`);
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}

function buildPrompt(spec) {
  return [
    `# Task ${spec.id}: ${spec.title}`,
    spec.body_excerpt,
    '',
    '## Acceptance criteria',
    ...spec.acceptance_criteria.map((c) => `- ${c}`),
    '',
    '## Scope',
    `Only modify: ${spec.touches.join(', ') || '(from context files)'}`,
    `Context files: ${spec.context_files.join(', ') || '(none listed)'}`,
    `Verify with: ${spec.test_command ?? 'the repo test suite'}`,
  ].join('\n');
}

export class LocalBackend {
  /**
   * @param {object} deps
   * @param {import('../mcp_clients/github.mjs').GitHubMCP} deps.github
   * @param {import('../sandbox_runner.mjs').SandboxRunner} deps.sandbox
   */
  constructor({ github, sandbox }) {
    this.github = github;
    this.sandbox = sandbox;
  }

  get name() { return 'local'; }

  /**
   * Execute one spec end to end:
   *   branch -> write files (structured impl from the spec) -> commit
   *   -> run the spec's test command in the sandbox -> return result.
   * The caller (dispatcher) owns retries, timeouts, and state transitions.
   */
  async run({ spec, branch }) {
    const files = implementationFor(spec);
    if (files.length === 0) {
      return { ok: false, reason: 'spec carries no impl block and no local backend can derive one — use the TrueForge backend for open-ended specs' };
    }

    await this.github.createBranch(branch, 'main');
    await this.github.commitFiles(branch, files, `feat(${spec.id}): ${spec.title}\n\nimplemented by foreman local backend`);

    const test = await this.sandbox.exec({
      branch,
      command: spec.test_command,
      taskId: spec.id,
    });
    return {
      ok: test.ok,
      branch,
      files: files.map((f) => f.path),
      test,
    };
  }
}

/**
 * Derive the file set for a spec. The planner lifts fenced ```impl blocks
 * (JSON: [{path, content}]) from the issue body into spec.impl; that is
 * what the local backend executes. Paths are sanitized platform-
 * independently: no absolute paths, no drive letters, no traversal.
 */
export function implementationFor(spec) {
  if (!Array.isArray(spec.impl)) return [];
  return spec.impl
    .filter((f) => f && typeof f.path === 'string' && typeof f.content === 'string')
    .filter((f) => !f.path.startsWith('/') && !/^[A-Za-z]:/.test(f.path) && !f.path.split(/[/\\]/).includes('..'))
    .map((f) => ({ path: f.path.replace(/^\/+/, '').replace(/\\/g, '/'), content: f.content }));
}
