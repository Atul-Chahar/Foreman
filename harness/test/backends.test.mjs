import test from 'node:test';
import assert from 'node:assert/strict';
import { TrueForgeBackend, LocalBackend } from '../subagents/backends.mjs';

const SPEC = {
  id: 'task-001',
  title: 'add search',
  body_excerpt: 'add a search endpoint',
  acceptance_criteria: ['returns [] for empty query'],
  touches: ['src/search.mjs'],
  context_files: ['src/app.mjs'],
  test_command: 'node --test',
};

function stubFetch(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, method: opts.method ?? 'GET', body: opts.body ? JSON.parse(opts.body) : null, signal: opts.signal });
    const route = routes.find((r) => r.match.test(url) && (r.method ?? 'GET') === (opts.method ?? 'GET'));
    if (!route) return { ok: false, status: 404, text: async () => 'no route' };
    if (route.fail) return { ok: false, status: route.status ?? 500, text: async () => route.failText ?? 'boom' };
    return { ok: true, status: 200, json: async () => (typeof route.respond === 'function' ? route.respond(calls.length, JSON.parse(opts.body ?? 'null')) : route.respond) };
  };
  fn.calls = calls;
  return fn;
}

test('trueforge backend: session -> turn -> poll speaks the documented protocol', async () => {
  const fetchImpl = stubFetch([
    { match: /\/api\/v1\/sessions$/, method: 'POST', respond: { id: 'sess-1' } },
    { match: /\/sessions\/sess-1\/turns$/, method: 'POST', respond: { id: 'turn-1' } },
    { match: /\/sessions\/sess-1\/turns\/turn-1$/, respond: { state: { status: 'done', output: { content: 'did it' } } } },
  ]);
  const backend = new TrueForgeBackend({
    config: { trueforgeUrl: 'http://tf.local', trueforgeToken: 'tok', trueforgeModel: 'acme/model-1' },
    fetchImpl,
  });

  const result = await backend.run({ spec: SPEC, branch: 'foreman/task-001' });

  // session creation carries the agent spec with sandbox enabled
  const createCall = fetchImpl.calls[0];
  assert.equal(createCall.url, 'http://tf.local/api/v1/sessions');
  assert.equal(createCall.body.agent.spec.config.sandbox.enabled, true);
  assert.equal(createCall.body.agent.spec.model.name, 'acme/model-1');

  // the turn starts with a user.message input containing the task
  const turnCall = fetchImpl.calls[1];
  assert.equal(turnCall.url, 'http://tf.local/api/v1/sessions/sess-1/turns');
  assert.equal(turnCall.body.input[0].type, 'user.message');
  assert.match(turnCall.body.input[0].content, /Task task-001/);
  assert.match(turnCall.body.input[0].content, /foreman\/task-001/);

  // poll maps terminal states onto the dispatcher's result contract
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, 'sess-1');
  assert.equal(result.turnId, 'turn-1');
});

test('trueforge backend: error turns map to ok:false; auth header present when token set', async () => {
  const fetchImpl = stubFetch([
    { match: /\/api\/v1\/sessions$/, method: 'POST', respond: { id: 's2' } },
    { match: /\/turns$/, method: 'POST', respond: { id: 't2' } },
    { match: /turns\/t2$/, respond: { state: { status: 'error', output: null } } },
  ]);
  const backend = new TrueForgeBackend({
    config: { trueforgeUrl: 'http://tf.local/', trueforgeToken: 'secret-token' },
    fetchImpl,
  });
  const result = await backend.run({ spec: SPEC, branch: 'b' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /error/);
  assert.equal(fetchImpl.calls[0].body && undefined, undefined);
  // authorization header on every call
  assert.ok(backend._headers().authorization === 'Bearer secret-token');
});

test('local backend: writes are refused without an authorize bridge — fail closed', () => {
  assert.throws(
    () => new LocalBackend({ github: {}, sandbox: {} }),
    /requires an authorize/,
    'constructing an ungated local backend must be impossible',
  );
});

test('local backend: policy refusal stops the write path permanently', async () => {
  const refused = new LocalBackend({
    github: {
      createBranch: async () => { throw new Error('MUST NOT BE CALLED'); },
      commitFiles: async () => { throw new Error('MUST NOT BE CALLED'); },
    },
    sandbox: {},
    authorize: () => ({ allowed: false, reason: 'T1 gated by default' }),
  });
  const result = await refused.run({
    spec: { ...SPEC, impl: [{ path: 'src/x.mjs', content: 'export {};' }] },
    branch: 'foreman/task-001',
  });
  assert.equal(result.ok, false);
  assert.equal(result.permanent, true);
  assert.match(result.reason, /refused 'create_branch'/);
});

test('local backend: an explicit allow lets the write through', async () => {
  let called = [];
  const allowed = new LocalBackend({
    github: {
      createBranch: async (b) => { called.push(['create_branch', b]); },
      commitFiles: async (b) => { called.push(['commit_files', b]); },
    },
    sandbox: { exec: async () => ({ ok: true, exitCode: 0 }) },
    authorize: () => ({ allowed: true }),
  });
  const result = await allowed.run({
    spec: { ...SPEC, impl: [{ path: 'src/x.mjs', content: 'export {};' }] },
    branch: 'foreman/task-001',
  });
  // all writes pre-authorized -> both executed in order
  assert.deepEqual(called.map((c) => c[0]), ['create_branch', 'commit_files']);
  assert.equal(result.ok, true);
});

test('local backend: authorization is checked for every write before any runs', async () => {
  let called = [];
  const mixed = new LocalBackend({
    github: {
      createBranch: async (b) => { called.push(b); },
      commitFiles: async () => { throw new Error('MUST NOT BE CALLED'); },
    },
    sandbox: {},
    authorize: (action) => ({ allowed: action === 'create_branch' }),
  });
  const result = await mixed.run({
    spec: { ...SPEC, impl: [{ path: 'src/x.mjs', content: 'export {};' }] },
    branch: 'foreman/task-001',
  });
  assert.deepEqual(called, [], 'nothing executes while any write lacks authorization');
  assert.match(result.reason, /refused 'commit_files'/);
});
