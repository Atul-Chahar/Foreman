// Execution backends for implementer subagents.
//
//   TrueForgeBackend — the real thing: creates a TrueForge SESSION whose
//     agent spec runs the implementer role, then starts a TURN carrying the
//     task prompt. Agent code executes in TrueForge's sandbox; results come
//     back as the turn's final output. Protocol (TrueForge REST API):
//       POST /api/v1/sessions            { agent: { spec: {...} } }
//       POST /api/v1/sessions/:id/turns  { input: [{ type: 'user.message', content }] }
//       POST may stream SSE to terminal status; older servers use GET polling
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
   * @param {import('../mcp_clients/github.mjs').GitHubMCP} deps.github
   * @param {import('../sandbox_runner.mjs').SandboxRunner} deps.sandbox
   * @param {(action: string, ctx: object) => Promise<{allowed: boolean, reason?: string}>} deps.authorize
   */
  constructor({
    config,
    fetchImpl = globalThis.fetch,
    registry = null,
    github,
    sandbox,
    authorize,
  }) {
    if (!config.trueforgeUrl) throw new Error('TrueForgeBackend requires FOREMAN_TRUEFORGE_URL');
    if (!github || !sandbox || typeof authorize !== 'function') {
      throw new Error('TrueForgeBackend requires github, sandbox, and an authorize(action, ctx) policy bridge');
    }
    this.url = config.trueforgeUrl.replace(/\/+$/, '');
    this.token = config.trueforgeToken;
    this.model = config.trueforgeModel || null; // server default when unset
    this.fetch = fetchImpl;
    this.registry = registry;
    this.github = github;
    this.sandbox = sandbox;
    this.authorize = authorize;
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
    const json = typeof res.text === 'function'
      ? parseTrueForgeResponse(await res.text())
      : await res.json();
    // Current TrueForge releases wrap successful REST payloads in `data`;
    // older builds returned the resource directly. Accept both versions.
    return json?.data ?? json;
  }

  /** The agent spec sent at session creation: sandboxed, instructions baked
   *  in from the task's skill role. */
  _agentSpec(skill) {
    const spec = {
      instructions:
        `You are the ${skill} agent of the Foreman swarm. Read the task below, ` +
        `implement exactly its acceptance criteria on the given branch, run the ` +
        `verification command inside your sandbox, and report the result. ` +
        `Never touch anything outside the stated scope. Your final response ` +
        `must be only JSON in this exact shape: ` +
        `{"files":[{"path":"relative/path","content":"complete file contents"}]}.`,
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
    if (!sessionId) throw new Error('trueforge create-session response did not contain an id');

    // 2. start the turn that carries the actual task
    const turn = await this._json(`/api/v1/sessions/${sessionId}/turns`, {
      method: 'POST',
      body: { input: [{ type: 'user.message', content: this.buildPrompt({ ...spec, branch }) }] },
      signal,
    });
    const turnId = this.turnIdFrom(turn);
    if (!turnId) throw new Error('trueforge create-turn response did not contain an id');

    // 3. poll the turn to a terminal state
    const completed = this.completionFromTurnResponse(sessionId, turnId, turn)
      ?? await this.awaitTurn(sessionId, turnId, { signal });
    return this.materializeCompletion({ completed, spec, branch });
  }

  async materializeCompletion({ completed, spec, branch }) {
    if (!completed.ok) return completed;
    // 4. TrueForge is the brain, not an ungated write channel. Its output is
    // validated into a file envelope, then materialized through the exact
    // same policy -> branch -> commit -> sandbox-test path as local runs.
    const files = extractTrueForgeFiles(completed.output);
    if (files.length === 0) {
      return {
        ...completed,
        ok: false,
        permanent: true,
        reason: 'trueforge completed without a valid {"files":[{"path","content"}]} result',
      };
    }
    const materialized = await materializeFiles({
      spec,
      branch,
      files,
      github: this.github,
      sandbox: this.sandbox,
      authorize: this.authorize,
      commitMessage: `feat(${spec.id}): ${spec.title}\n\nimplemented by foreman trueforge backend`,
    });
    return { ...completed, ...materialized, output: completed.output };
  }

  turnIdFrom(turn) {
    return turn.id
      ?? turn.turnId
      ?? turn.turn_id
      ?? turn.events?.find((event) => event.type === 'turn.created')?.turn_id
      ?? null;
  }

  /** Newer TrueForge releases keep POST /turns open as an SSE stream until
   * completion. Map its terminal event directly; older JSON responses fall
   * through to GET polling. */
  completionFromTurnResponse(sessionId, turnId, turn) {
    const terminal = turn.events?.findLast?.((event) =>
      event.type === 'turn.done' || event.type === 'turn.error' || event.type === 'turn.cancelled',
    );
    return terminal ? this._turnResult(sessionId, turnId, terminal.state) : null;
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
      '',
      '## Required final response',
      'Return only JSON. Do not use Markdown fences or commentary:',
      '{"files":[{"path":"relative/path","content":"complete file contents"}]}',
    ].join('\n');
  }

  async awaitTurn(sessionId, turnId, { pollMs = 2000, maxMs = 600_000, signal } = {}) {
    const deadline = Date.now() + maxMs;
    for (;;) {
      if (signal?.aborted) throw new Error(`trueforge turn ${turnId} aborted`);
      const t = await this._json(`/api/v1/sessions/${sessionId}/turns/${turnId}`, { signal });
      const result = this._turnResult(sessionId, turnId, t?.state ?? t);
      if (result) return result;
      if (Date.now() > deadline) throw new Error(`trueforge turn ${turnId} exceeded ${maxMs}ms`);
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  _turnResult(sessionId, turnId, state) {
    const status = state?.status;
    const succeeded = status === 'done' || status === 'completed' || status === 'succeeded';
    const failed = status === 'cancelled' || status === 'error' || status === 'failed';
    if (!succeeded && !failed) return null;
    const output = state?.output ?? null;
    return {
      ok: succeeded,
      permanent: failed && /not implemented|cannot|refus/i.test(JSON.stringify(output ?? '')),
      reason: failed ? `trueforge turn ${status}` : undefined,
      sessionId,
      turnId,
      output,
      metrics: state?.metrics ?? null,
    };
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

    return materializeFiles({
      spec,
      branch,
      files,
      github: this.github,
      sandbox: this.sandbox,
      authorize: this.authorize,
      commitMessage: `feat(${spec.id}): ${spec.title}\n\nimplemented by foreman local backend`,
    });
  }
}

/**
 * Derive the file set for a spec. The planner lifts fenced ```impl blocks
 * (JSON: [{path, content}]) from the issue body into spec.impl; that is
 * what the local backend executes. Paths are sanitized platform-
 * independently: no absolute paths, no drive letters, no traversal.
 */
export function implementationFor(spec) {
  return sanitizeFiles(spec.impl);
}

/** Extract the strict file envelope requested from a TrueForge turn. The
 * API may wrap the assistant text in `content` blocks, so unwrap those while
 * keeping the write contract itself deliberately small and deterministic.
 * One malformed, duplicate, absolute, or traversing path rejects the whole
 * envelope; model output is never partially trusted. */
export function extractTrueForgeFiles(output) {
  const candidates = collectOutputCandidates(output);
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && Array.isArray(candidate.files)) {
      const files = strictEnvelopeFiles(candidate.files);
      if (files.length > 0) return files;
    }
    if (typeof candidate !== 'string') continue;
    for (const json of jsonCandidates(candidate)) {
      try {
        const parsed = JSON.parse(json);
        if (!Array.isArray(parsed?.files)) continue;
        const files = strictEnvelopeFiles(parsed.files);
        if (files.length > 0) return files;
      } catch { /* try the next possible envelope */ }
    }
  }
  return [];
}

async function materializeFiles({ spec, branch, files, github, sandbox, authorize, commitMessage }) {
  for (const [action, detail] of [
    ['create_branch', { branch }],
    ['commit_files', { branch, files: files.map((f) => f.path) }],
  ]) {
    const verdict = await authorize(action, { taskId: spec.id, ...detail });
    if (!verdict?.allowed) {
      return {
        ok: false,
        permanent: true,
        reason: `backend refused '${action}': ${verdict?.reason ?? 'not authorized'}`,
      };
    }
  }

  await github.createBranch(branch, 'main');
  await github.commitFiles(branch, files, commitMessage);
  const test = await sandbox.exec({ branch, command: spec.test_command, taskId: spec.id });
  return { ok: test.ok, branch, files: files.map((f) => f.path), test };
}

function sanitizeFiles(files) {
  if (!Array.isArray(files)) return [];
  return files
    .filter((f) => f && typeof f.path === 'string' && f.path.length > 0 && typeof f.content === 'string')
    .filter((f) => !f.path.startsWith('/') && !/^[A-Za-z]:/.test(f.path) && !f.path.split(/[/\\]/).includes('..'))
    .map((f) => ({ path: f.path.replace(/^\/+/, '').replace(/\\/g, '/'), content: f.content }));
}

function strictEnvelopeFiles(files) {
  const sanitized = sanitizeFiles(files);
  if (sanitized.length !== files.length) return [];
  if (new Set(sanitized.map((file) => file.path)).size !== sanitized.length) return [];
  return sanitized;
}

function collectOutputCandidates(value, seen = new Set()) {
  if (value === null || value === undefined || seen.has(value)) return [];
  if (typeof value === 'string') return [value];
  if (typeof value !== 'object') return [];
  seen.add(value);
  const out = [value];
  if (Array.isArray(value)) {
    for (const item of value) out.push(...collectOutputCandidates(item, seen));
    return out;
  }
  for (const key of ['content', 'text', 'message', 'value', 'result', 'output']) {
    if (key in value) out.push(...collectOutputCandidates(value[key], seen));
  }
  return out;
}

function jsonCandidates(text) {
  const trimmed = text.trim();
  const out = [trimmed];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match;
  while ((match = fenced.exec(trimmed)) !== null) out.push(match[1].trim());
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) out.push(trimmed.slice(start, end + 1));
  return [...new Set(out)];
}

function parseTrueForgeResponse(text) {
  try {
    return JSON.parse(text);
  } catch {
    const events = String(text)
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter((line) => line && line !== '[DONE]')
      .flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
    if (events.length > 0) return { events };
    throw new Error(`trueforge returned neither JSON nor SSE (${String(text).slice(0, 120)})`);
  }
}
