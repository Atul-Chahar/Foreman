// Execution backends for implementer subagents.
//
//   TrueForgeBackend — the real thing: creates a TrueForge SESSION whose
//     agent spec runs the implementer role, then starts a TURN carrying the
//     task prompt. Agent code executes in TrueForge's sandbox; results come
//     back as the turn's final output. Protocol (TrueForge REST API):
//       POST /api/v1/sessions            { agent: { spec: {...} } }
//       POST /api/v1/sessions/:id/turns  { input: [{ type: 'user.message', content }] }
//       GET  /api/v1/sessions/:id/turns/:turnId   until terminal status
//
//   LocalBackend — the deterministic fallback: executes the spec directly
//     (structured `impl` files + generated test scaffolding) against the
//     target repo over MCP. No credentials required; used for offline runs,
//     CI, and the seeded demo. Same lifecycle, same gates, same events —
//     only the "brain" differs.

import path from 'node:path';
import { composePrompt } from '../skills/loader.mjs';

export class TrueForgeBackend {
  /**
   * @param {object} deps
   * @param {import('../config.mjs').Config} deps.config
   * @param {Function} [deps.fetchImpl] injectable fetch (tests)
   * @param {import('../skills/loader.mjs').SkillRegistry} [deps.registry]
   *        when set, prompts are composed from skills (role + competencies);
   *        otherwise a plain structured spec prompt is used
   */
  constructor({ config, fetchImpl = globalThis.fetch, registry = null }) {
    if (!config.trueforgeUrl) throw new Error('TrueForgeBackend requires FOREMAN_TRUEFORGE_URL');
    this.url = config.trueforgeUrl.replace(/\/+$/, '');
    this.token = config.trueforgeToken;
    this.model = config.trueforgeModel || null; // server default when unset
    this.fetch = fetchImpl;
    this.registry = registry;
  }

  get name() { return 'trueforge'; }

  _headers(extra = {}) {
    return {
      'content-type': 'application/json',
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      ...extra,
    };
  }

  async _json(path, { method = 'GET', body, signal } = {}) {
    const res = await this.fetch(`${this.url}${path}`, {
      method,
      headers: this._headers(),
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    if (!res.ok) throw new Error(`trueforge ${method} ${path} failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  /** The agent spec sent at session creation: sandboxed, instructions baked
   *  in from the task's skill role. */
  _agentSpec(skill) {
    const spec = {
      instructions:
        `You are the ${skill} agent of the Foreman swarm. Read the task below, ` +
        `implement exactly its acceptance criteria on the given branch, run the ` +
        `verification command inside your sandbox, and report the result. ` +
        `Never touch anything outside the stated scope.`,
      config: { sandbox: { enabled: true } }, // agent code NEVER runs on our host
    };
    if (this.model) spec.model = { name: this.model };
    return spec;
  }

  /**
   * Run one spec: session -> turn -> poll to a terminal state.
   * @param {{signal?: AbortSignal}} [opts] abort cancels the HTTP work
   */
  async run({ spec, branch, skill = 'implementer', signal }) {
    // 1. create the session
    const session = await this._json('/api/v1/sessions', {
      method: 'POST',
      body: { agent: { spec: this._agentSpec(skill) } },
      signal,
    });
    const sessionId = session.id ?? session.sessionId;

    // 2. start the turn that carries the actual task
    const turn = await this._json(`/api/v1/sessions/${sessionId}/turns`, {
      method: 'POST',
      body: { input: [{ type: 'user.message', content: this.buildPrompt({ ...spec, branch }) }] },
      signal,
    });
    const turnId = turn.id ?? turn.turnId ?? turn.turn_id;

    // 3. poll the turn to a terminal state
    return this.awaitTurn(sessionId, turnId, { signal });
  }

  /**
   * Skill-driven prompt: role + competencies + structured spec block.
   * Falls back to a plain spec prompt when no registry is available.
   */
  buildPrompt(spec) {
    if (this.registry) {
      return composePrompt({
        role: 'implementer',
        registry: this.registry,
        // fix agents get build-fix; plain implementers get tdd + search
        extraSkills: spec.source === 'reconciler'
          ? ['build-fix', 'search-first']
          : ['tdd-workflow', 'search-first'],
        spec,
      });
    }
    return [
      `# Task ${spec.id}: ${spec.title}`,
      spec.body_excerpt,
      '',
      '## Acceptance criteria',
      ...(spec.acceptance_criteria ?? []).map((c) => `- ${c}`),
      '',
      '## Scope',
      `Work on branch: ${spec.branch ?? '(assigned by dispatcher)'}`,
      `Only modify: ${(spec.touches ?? []).join(', ') || '(from context files)'}`,
      `Context files: ${(spec.context_files ?? []).join(', ') || '(none listed)'}`,
      `Verify with: ${spec.test_command ?? 'the repo test suite'}`,
    ].join('\n');
  }

  async awaitTurn(sessionId, turnId, { pollMs = 2000, maxMs = 600_000, signal } = {}) {
>>>>>>> a78ef27 (feat(orchestrator): wire skills registry, review stage, and run loop)
    const deadline = Date.now() + maxMs;
    for (;;) {
      if (signal?.aborted) throw new Error(`trueforge turn ${turnId} aborted`);
      const t = await this._json(`/api/v1/sessions/${sessionId}/turns/${turnId}`, { signal });
      const status = t?.state?.status ?? t.status;
      if (status === 'done' || status === 'cancelled' || status === 'error') {
        const failed = status !== 'done';
        const output = t?.state?.output ?? null;
        return {
          ok: !failed,
          permanent: failed && /not implemented|cannot|refus/i.test(JSON.stringify(output ?? '')),
          reason: failed ? `trueforge turn ${status}` : undefined,
          sessionId,
          turnId,
          output,
          metrics: t?.state?.metrics ?? null,
        };
      }
      if (Date.now() > deadline) throw new Error(`trueforge turn ${turnId} exceeded ${maxMs}ms`);
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}

export class LocalBackend {
  /**
   * @param {object} deps
   * @param {import('../mcp_clients/github.mjs').GitHubMCP} deps.github
   * @param {import('../sandbox_runner.mjs').SandboxRunner} deps.sandbox
   * @param {(action: string, ctx: object) => {allowed: boolean, reason?: string}} deps.authorize
   *        policy bridge — REQUIRED. Every protected write names its action so
   *        the caller can route it through the policy engine; the backend
   *        refuses to write without an explicit yes.
   */
  constructor({ github, sandbox, authorize }) {
    if (typeof authorize !== 'function') {
      throw new Error('LocalBackend requires an authorize(action, ctx) policy bridge — writes are refused without one');
    }
    this.github = github;
    this.sandbox = sandbox;
    this.authorize = authorize;
  }

  get name() { return 'local'; }

  /**
   * Execute one spec end to end:
   *   branch -> write files (structured impl from the spec) -> commit
   *   -> run the spec's test command in the sandbox -> return result.
   * The caller (dispatcher) owns retries, timeouts, and state transitions;
   * the POLICY owns whether the writes may happen at all.
   */
  async run({ spec, branch }) {
    const files = implementationFor(spec);
    if (files.length === 0) {
      // permanent: no retry can conjure an implementation — a human or the
      // TrueForge backend must take this spec
      return {
        ok: false,
        permanent: true,
        reason: 'spec carries no impl block and no local backend can derive one — use the TrueForge backend for open-ended specs',
      };
    }

    for (const [action, detail] of [
      ['create_branch', { branch }],
      ['commit_files', { branch, files: files.map((f) => f.path) }],
    ]) {
      const verdict = this.authorize(action, { taskId: spec.id, ...detail });
      if (!verdict?.allowed) {
        return {
          ok: false,
          permanent: true,
          reason: `local backend refused '${action}': ${verdict?.reason ?? 'not authorized'}`,
        };
      }
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
