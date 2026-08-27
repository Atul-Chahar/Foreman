#!/usr/bin/env node
// Seed the demo target repo (Repo B): a small TODO API with a green test
// suite and a backlog of seeded issues that exercise every part of Foreman —
// parallel features, a conflicting pair, a broken impl (reconciler demo),
// a destructive-flavored issue (T2 escalation), and a leaky impl (reviewer
// blocking demo).
//
// The target is a REAL local git repo and the issues go through the same
// MCP tool surface the orchestrator uses (loadConfig() paths), so a
// subsequent `foreman demo` sees exactly this backlog. Idempotent; --reset
// wipes target + localhub state.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../harness/config.mjs';
import { LocalGitMCP } from '../harness/mcp_clients/local_git.mjs';

// Assembled from parts so no PAT-shaped literal exists in THIS repository's
// source (our own scanners would flag it). At demo runtime the generated
// webhook.mjs DOES contain a token-shaped dummy — deliberately: the seeded
// "add webhook" task exists so the review stage visibly blocks a hardcoded
// secret before any PR opens. It is never a real credential.
const FAKE_TOKEN = ['ghp_', 'F'.repeat(24), '1234'].join('');

const README = `# demo-target

A toy TODO API. This is the repo the foreman swarm works on: seeded issues
become task specs, subagents implement them on their own branches, and
every merge still waits for a human.

Run the suite: node --test test/
`;

const PKG = JSON.stringify({ name: 'demo-target', type: 'module', private: true }, null, 2);

const DB = `// the whole "database": an in-memory list of todos
export const todos = [
  { id: 1, title: 'write the README', done: true },
  { id: 2, title: 'seed the backlog', done: true },
  { id: 3, title: 'supervise the swarm', done: false },
];

let nextId = 4;
export function addTodo(title) {
  const todo = { id: nextId++, title, done: false };
  todos.push(todo);
  return todo;
}

export function listTodos() {
  return [...todos];
}
`;

const ROUTES = `import { listTodos, addTodo } from '../db.mjs';

export function handle(method, url) {
  if (method === 'GET' && url === '/todos') {
    return { status: 200, body: listTodos() };
  }
  if (method === 'POST' && url === '/todos') {
    return { status: 201, body: { error: 'not implemented — see the backlog' } };
  }
  return { status: 404, body: { error: 'not found' } };
}
`;

const HEALTH = `import { listTodos } from './db.mjs';

export const health = () => (listTodos().length > 0 ? 1 : 0);
`;

const MAIN_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/routes/todos.mjs';
import { health } from '../src/health.mjs';

test('GET /todos returns the list', () => {
  const res = handle('GET', '/todos');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
});

test('health is green while todos exist', () => {
  assert.equal(health(), 1);
});
`;

function git(dir, args, { check = true } = {}) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
  if (check && r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim()}`);
  }
  return r;
}

const TEST_CMD = 'node --test'; // runs the whole suite, including tests the agents add

/** The seeded backlog. Order matters only for readability. */
function issues() {
  return [
    {
      title: 'Add create-todo endpoint (POST /todos)',
      body: [
        'Users cannot add todos today. Implement POST /todos in src/routes/todos.mjs.',
        '',
        'acceptance:',
        '- POST /todos with {title} stores a todo and returns 201 with it',
        '- the stored todo appears in the next GET /todos',
        '',
        `test: \`${TEST_CMD}\``,
        '',
        '```impl',
        JSON.stringify([
          {
            path: 'src/routes/todos.mjs',
            content: `import { listTodos, addTodo } from '../db.mjs';

export function handle(method, url, body) {
  if (method === 'GET' && url === '/todos') {
    return { status: 200, body: listTodos() };
  }
  if (method === 'POST' && url === '/todos') {
    const title = body?.title;
    if (!title) return { status: 400, body: { error: 'title is required' } };
    return { status: 201, body: addTodo(String(title)) };
  }
  return { status: 404, body: { error: 'not found' } };
}
`,
          },
          {
            path: 'test/post.test.mjs',
            content: `import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/routes/todos.mjs';

test('POST /todos creates and returns the todo', () => {
  const res = handle('POST', '/todos', { title: 'supervise a swarm' });
  assert.equal(res.status, 201);
  assert.equal(res.body.title, 'supervise a swarm');
  assert.equal(res.body.done, false);
});

test('created todo shows up in the list', () => {
  const created = handle('POST', '/todos', { title: 'visible now' });
  const list = handle('GET', '/todos');
  assert.ok(list.body.some((t) => t.id === created.body.id));
});

test('missing title is a 400', () => {
  const res = handle('POST', '/todos', {});
  assert.equal(res.status, 400);
});
`,
          },
        ]),
        '```',
      ].join('\n'),
    },
    {
      title: 'Add health endpoint (GET /health)',
      body: [
        'Expose service health at GET /health.',
        '',
        'acceptance:',
        '- GET /health returns 200 with {ok:true} while todos exist',
        '',
        `test: \`${TEST_CMD}\``,
        '',
        '```impl',
        JSON.stringify([
          {
            path: 'src/health.mjs',
            content: `import { listTodos } from './db.mjs';

export const health = () => (listTodos().length > 0 ? 1 : 0);
`,
          },
        ]),
        '```',
      ].join('\n'),
    },
    {
      title: 'Add todo validation helper',
      body: [
        'Extract title validation into src/validate.mjs so routes share it.',
        '',
        'acceptance:',
        '- validTitle(x) returns true for non-empty strings, false otherwise',
        '',
        `test: \`${TEST_CMD}\``,
        '',
        '```impl',
        JSON.stringify([
          {
            path: 'src/validate.mjs',
            content: `export function validTitle(title) {
  return typeof title === 'string' && title.trim().length > 0;
}
`,
          },
          {
            path: 'test/validate.test.mjs',
            content: `import test from 'node:test';
import assert from 'node:assert/strict';
import { validTitle } from '../src/validate.mjs';

test('validTitle accepts non-empty strings', () => assert.equal(validTitle('x'), true));
test('validTitle rejects junk', () => {
  assert.equal(validTitle(''), false);
  assert.equal(validTitle(null), false);
  assert.equal(validTitle(42), false);
});
`,
          },
        ]),
        '```',
      ].join('\n'),
    },
    {
      title: 'Add pagination support to GET /todos',
      body: [
        'GET /todos should honor ?limit= so callers can page.',
        'Touches src/routes/todos.mjs — coordinate with other route work.',
        '',
        'acceptance:',
        '- GET /todos?limit=1 returns at most one todo',
        '- no limit returns everything (existing behavior preserved)',
        '',
        `test: \`${TEST_CMD}\``,
        '',
        '```impl',
        JSON.stringify([
          {
            path: 'src/routes/todos.mjs',
            content: `import { listTodos, addTodo } from '../db.mjs';

export function handle(method, url, body) {
  const [path, query] = url.split('?');
  if (method === 'GET' && path === '/todos') {
    const params = new URLSearchParams(query ?? '');
    const limit = Number(params.get('limit') ?? Infinity);
    return { status: 200, body: listTodos().slice(0, limit) };
  }
  if (method === 'POST' && path === '/todos') {
    return { status: 201, body: { error: 'not implemented here — see POST task' } };
  }
  return { status: 404, body: { error: 'not found' } };
}
`,
          },
          {
            path: 'test/pagination.test.mjs',
            content: `import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/routes/todos.mjs';

test('GET /todos?limit=1 pages', () => {
  handle('POST', '/todos', { title: 'a' });
  handle('POST', '/todos', { title: 'b' });
  const res = handle('GET', '/todos?limit=1');
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
});
`,
          },
        ]),
        '```',
      ].join('\n'),
    },
    {
      title: 'Return proper 405 for unsupported methods on /todos',
      body: [
        'DELETE on /todos currently 404s; it should 405.',
        'Touches src/routes/todos.mjs — coordinate with other route work.',
        '',
        'acceptance:',
        '- DELETE /todos returns 405 with an Allow header hint in the body',
        '',
        `test: \`${TEST_CMD}\``,
        '',
        '```impl',
        JSON.stringify([
          {
            path: 'src/routes/todos.mjs',
            content: `import { listTodos, addTodo } from '../db.mjs';

export function handle(method, url, body) {
  if (method === 'GET' && url === '/todos') return { status: 200, body: listTodos() };
  if (method === 'POST' && url === '/todos') {
    return { status: 201, body: { error: 'not implemented here — see POST task' } };
  }
  if (url === '/todos') {
    // known resource, unsupported method: 405 per RFC 9110
    return { status: 405, body: { error: 'method not allowed', allow: 'GET, POST' } };
  }
  return { status: 404, body: { error: 'not found' } };
}
`,
          },
          {
            path: 'test/method405.test.mjs',
            content: `import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/routes/todos.mjs';

test('DELETE /todos is a 405, not a 404', () => {
  const res = handle('DELETE', '/todos');
  assert.equal(res.status, 405);
  assert.ok(res.body.allow.includes('GET'));
});

test('unknown paths still 404', () => {
  assert.equal(handle('DELETE', '/nope').status, 404);
});
`,
          },
        ]),
        '```',
      ].join('\n'),
    },
    {
      // conflicts with "pagination" and "405" — same file in touches
      title: 'Add done-toggle endpoint (POST /todos/:id/done)',
      body: [
        'Users need to mark todos done. Extend the router in src/routes/todos.mjs.',
        '',
        'acceptance:',
        '- POST /todos/3/done marks todo 3 done and returns it',
        '',
        `test: \`${TEST_CMD}\``,
        '',
        '```impl',
        JSON.stringify([
          {
            path: 'src/routes/todos.mjs',
            content: `import { listTodos, addTodo, toggleDone } from '../db.mjs';

export function handle(method, url, body) {
  const done = /^\\/todos\\/(\\d+)\\/done$/.exec(url);
  if (method === 'POST' && done) {
    const updated = toggleDone(Number(done[1]));
    return updated ? { status: 200, body: updated } : { status: 404, body: { error: 'not found' } };
  }
  if (method === 'GET' && url === '/todos') return { status: 200, body: listTodos() };
  if (method === 'POST' && url === '/todos') {
    return { status: 201, body: { error: 'not implemented here — see POST task' } };
  }
  return { status: 404, body: { error: 'not found' } };
}
`,
          },
          {
            path: 'src/db.mjs',
            content: `// in-memory store (the legacy table the reconciler demo later drops)
let todos = [
  { id: 1, title: 'write the README', done: true },
  { id: 2, title: 'seed the backlog', done: true },
  { id: 3, title: 'supervise the swarm', done: false },
];

export function addTodo(title) {
  const todo = { id: todos.length + 1, title, done: false };
  todos.push(todo);
  return todo;
}

export function listTodos() {
  return todos;
}

export function toggleDone(id) {
  const todo = todos.find((t) => t.id === id);
  if (!todo) return null;
  todo.done = !todo.done;
  return todo;
}
`,
          },
          {
            path: 'test/done.test.mjs',
            content: `import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/routes/todos.mjs';

test('POST /todos/3/done toggles todo 3', () => {
  const res = handle('POST', '/todos/3/done');
  assert.equal(res.status, 200);
  assert.equal(res.body.done, true);
});

test('unknown id is a 404', () => {
  assert.equal(handle('POST', '/todos/999/done').status, 404);
});
`,
          },
        ]),
        '```',
      ].join('\n'),
    },
    {
      title: 'Add search filtering (GET /todos?q=)',
      body: [
        'Filter the list by substring. Reads routes + db, writes both — pairs with route work.',
        'Touches src/routes/todos.mjs and src/db.mjs.',
        '',
        'acceptance:',
        '- GET /todos?q=swarm returns only matching titles',
        '- empty q returns all',
        '',
        `test: \`${TEST_CMD}\``,
        '',
        '```impl',
        JSON.stringify([
          {
            path: 'src/routes/todos.mjs',
            content: `import { listTodos, addTodo } from '../db.mjs';

export function handle(method, url, body) {
  const [path, query] = url.split('?');
  if (method === 'GET' && path === '/todos') {
    const params = new URLSearchParams(query ?? '');
    const q = (params.get('q') ?? '').toLowerCase();
    const all = listTodos();
    return { status: 200, body: q ? all.filter((t) => t.title.toLowerCase().includes(q)) : all };
  }
  if (method === 'POST' && path === '/todos') {
    return { status: 201, body: { error: 'not implemented here — see POST task' } };
  }
  return { status: 404, body: { error: 'not found' } };
}
`,
          },
          {
            path: 'test/search.test.mjs',
            content: `import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/routes/todos.mjs';

test('q filters by substring', () => {
  handle('POST', '/todos', { title: 'swarm supervisor' });
  handle('POST', '/todos', { title: 'unrelated' });
  const res = handle('GET', '/todos?q=swarm');
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].title, 'swarm supervisor');
});

test('empty q returns everything', () => {
  assert.ok(handle('GET', '/todos').body.length >= 2);
});
`,
          },
        ]),
        '```',
      ].join('\n'),
    },
    {
      // intentionally broken impl: dispatch fails tests -> retry -> failed -> reconciler demo
      title: 'Add stats endpoint (GET /stats)',
      body: [
        'Return counts for total/done todos.',
        '',
        'acceptance:',
        '- GET /stats returns {total, done} matching the db',
        '',
        `test: \`${TEST_CMD}\``,
        '',
        '```impl',
        JSON.stringify([
          {
            path: 'src/stats.mjs',
            content: `import { listTodos } from './db.mjs';

// NOTE: seeded intentionally WRONG (done counting is off by one) — this task
// demonstrates the sandbox catching a broken impl and the reconciler path.
export function stats() {
  const all = listTodos();
  return { total: all.length, done: all.filter((t) => t.done).length + 1 };
}
`,
          },
          {
            path: 'test/stats.test.mjs',
            content: `import test from 'node:test';
import assert from 'node:assert/strict';
import { stats } from '../src/stats.mjs';

test('stats counts correctly', () => {
  const s = stats();
  assert.equal(s.done, s.total - 1); // exactly one undone todo in the seed
});
`,
          },
        ]),
        '```',
      ].join('\n'),
    },
    {
      // destructive language -> planner escalates to T2
      title: 'Drop the legacy in-memory table',
      body: [
        'Delete the old todos array in src/db.mjs and rebuild storage cleanly.',
        'Destructive migration: requires careful review before merge to main.',
        '',
        'acceptance:',
        '- src/db.mjs exposes storage without the legacy array',
        '',
        `test: \`${TEST_CMD}\``,
      ].join('\n'),
    },
    {
      // leaked credential -> reviewer blocking demo (token is an obvious dummy)
      title: 'Add webhook notify stub',
      body: [
        'Notify an external webhook when a todo is created. Configuration comes later.',
        '',
        'acceptance:',
        '- a stub module exists that would POST to the configured webhook',
        '',
        `test: \`${TEST_CMD}\``,
        '',
        '```impl',
        JSON.stringify([
          {
            path: 'src/webhook.mjs',
            content: `// seeded intentionally INSECURE (hardcoded token) — the review stage must
// block this before any PR is proposed. The token is an obvious dummy.
const WEBHOOK_TOKEN = "${FAKE_TOKEN}";

export function notify(/* todo */) {
  // stub: would POST to the configured webhook with the token
  return { skipped: true, token: WEBHOOK_TOKEN.slice(0, 4) + '***' };
}
`,
          },
        ]),
        '```',
      ].join('\n'),
    },
  ];
}

export async function seedDemo(config = loadConfig(), { quiet = false, reset = false } = {}) {
  const targetDir = config.targetLocal;
  const stateFile = path.join(config.dataDir, 'localhub', 'state.json');
  const mcp = new LocalGitMCP(targetDir, stateFile);

  const exists = fs.existsSync(path.join(targetDir, '.git'));
  if (reset) {
    if (exists) fs.rmSync(targetDir, { recursive: true, force: true });
    if (fs.existsSync(stateFile)) fs.rmSync(stateFile);
    // a fresh local issue tracker must not sit on top of stale task state:
    // recreated issue numbers would silently map onto old tasks
    const dbFile = path.join(config.dataDir, 'foreman.db');
    for (const suffix of ['', '-wal', '-shm']) {
      const f = `${dbFile}${suffix}`;
      if (fs.existsSync(f)) fs.rmSync(f);
    }
    log(quiet, 'reset: target repo, localhub state and foreman task store wiped');
  }

  if (!fs.existsSync(path.join(targetDir, '.git'))) {
    log(quiet, `seeding demo target at ${targetDir}`);
    fs.mkdirSync(targetDir, { recursive: true });
    git(targetDir, ['init', '-b', 'main']);
    write(targetDir, 'README.md', README);
    write(targetDir, 'package.json', PKG);
    write(targetDir, 'src/db.mjs', DB);
    write(targetDir, 'src/routes/todos.mjs', ROUTES);
    write(targetDir, 'src/health.mjs', HEALTH);
    write(targetDir, 'test/main.test.mjs', MAIN_TEST);
    git(targetDir, ['add', '.']);
    git(targetDir, ['-c', 'user.name=demo-seed', '-c', 'user.email=seed@demo.local', 'commit', '-m', 'chore: seed demo TODO API']);
    // verify the starter is actually green before seeding work on top of it
    const check = spawnSync(process.execPath, ['--test', 'test/main.test.mjs'], {
      cwd: targetDir, encoding: 'utf8', windowsHide: true,
    });
    if (check.status !== 0) {
      throw new Error(`seeded starter suite is not green:\n${(check.stdout || check.stderr || '').slice(0, 2000)}`);
    }
    log(quiet, '  starter suite verified green: node --test test/main.test.mjs');
  } else {
    log(quiet, `demo target exists at ${targetDir} (reused)`);
  }

  const seeded = (await mcp.callTool('list_issues')).length;
  const closed = mcp._load().issues.filter((i) => i.state === 'closed').length;
  const totalEver = mcp._load().issues.length;
  if (seeded > 0 || (totalEver > 0 && closed > 0)) {
    log(quiet, `backlog already seeded (${seeded} open, ${closed} closed) — skipping`);
    return { targetDir, issues: seeded };
  }

  log(quiet, 'seeding backlog through the MCP tool surface');
  for (const issue of issues()) {
    await mcp.callTool('create_issue', { title: issue.title, body: issue.body, labels: ['demo'] });
  }
  const total = (await mcp.callTool('list_issues')).length;
  log(quiet, `  seeded ${total} issues:`);
  for (const i of await mcp.callTool('list_issues')) {
    log(quiet, `   #${String(i.number).padStart(2)} ${i.title}`);
  }
  return { targetDir, issues: total };
}

function write(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function log(quiet, msg) {
  if (!quiet) console.log(msg);
}

// run directly: node scripts/seed.mjs [--reset]
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  seedDemo(loadConfig(), { quiet: false, reset: process.argv.includes('--reset') })
    .then((r) => console.log(`\ndone: ${r.issues} issues seeded at ${r.targetDir}`))
    .catch((err) => { console.error(err.message); process.exit(1); });
}
