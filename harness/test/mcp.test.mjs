import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { LocalGitMCP } from '../mcp_clients/local_git.mjs';
import { RateLimiter } from '../mcp_clients/ratelimit.mjs';
import { GitHubMCP } from '../mcp_clients/github.mjs';
import { loadConfig } from '../config.mjs';

function scratchRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-mcp-'));
  const git = (args, opts = {}) =>
    spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, ...opts });
  git(['init', '-b', 'main']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo target\n');
  git(['add', '.']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init']);
  return { dir, stateFile: path.join(dir, '..', `${path.basename(dir)}-state.json`) };
}

test('local-git: issue lifecycle over the MCP tool surface', async () => {
  const { dir, stateFile } = scratchRepo();
  const mcp = new LocalGitMCP(dir, stateFile);
  await mcp.callTool('create_issue', { title: 'add search', body: 'q= param', labels: ['feature'] });
  const issues = await mcp.callTool('list_issues');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].number, 1);
  await mcp.callTool('close_issue', { number: 1 });
  assert.equal((await mcp.callTool('list_issues')).length, 0);
});

test('local-git: branch -> commit -> PR -> diff are real git operations', async () => {
  const { dir, stateFile } = scratchRepo();
  const mcp = new LocalGitMCP(dir, stateFile);

  await mcp.callTool('create_branch', { branch: 'foreman/task-001' });
  await mcp.callTool('commit_files', {
    branch: 'foreman/task-001',
    files: [{ path: 'src/search.mjs', content: 'export const search = () => [];\n' }],
    message: 'feat: search endpoint',
  });
  // the branch exists in real git, main is untouched
  const branches = spawnSync('git', ['-C', dir, 'branch', '--list', 'foreman/task-001'], { encoding: 'utf8' });
  assert.ok(branches.stdout.includes('foreman/task-001'));
  const mainTree = spawnSync('git', ['-C', dir, 'ls-tree', 'main', '--name-only'], { encoding: 'utf8' });
  assert.ok(!mainTree.stdout.includes('src/search.mjs'));

  const pr = await mcp.callTool('create_pull_request', {
    branch: 'foreman/task-001', title: 'feat: search', body: 'closes #1',
  });
  assert.equal(pr.number, 1);

  // idempotent: same branch never gets a second PR
  const again = await mcp.callTool('create_pull_request', { branch: 'foreman/task-001', title: 'dup' });
  assert.equal(again.number, 1);

  const full = await mcp.callTool('get_pull_request', { number: 1 });
  assert.ok(full.diff.includes('search.mjs'));
});

test('local-git: merge is a real merge; conflicts throw MERGE_CONFLICT', async () => {
  const { dir, stateFile } = scratchRepo();
  const mcp = new LocalGitMCP(dir, stateFile);

  // two branches touching the same line
  await mcp.callTool('create_branch', { branch: 'foreman/task-a' });
  await mcp.callTool('commit_files', {
    branch: 'foreman/task-a',
    files: [{ path: 'README.md', content: '# changed by A\n' }],
    message: 'a',
  });
  await mcp.callTool('create_branch', { branch: 'foreman/task-b' });
  await mcp.callTool('commit_files', {
    branch: 'foreman/task-b',
    files: [{ path: 'README.md', content: '# changed by B\n' }],
    message: 'b',
  });

  const prA = await mcp.callTool('create_pull_request', { branch: 'foreman/task-a', title: 'A' });
  const prB = await mcp.callTool('create_pull_request', { branch: 'foreman/task-b', title: 'B' });

  const merged = await mcp.callTool('merge_pull_request', { number: prA.number });
  assert.equal(merged.merged, true);
  const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
  assert.ok(readme.includes('changed by A'));

  await assert.rejects(
    () => mcp.callTool('merge_pull_request', { number: prB.number }),
    (e) => e.code === 'MERGE_CONFLICT',
  );
  // repo left clean after the conflict
  const status = spawnSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' });
  assert.equal(status.stdout.trim(), '');
});

test('local-git: branch diff and read-file-at-ref work without a PR', async () => {
  const { dir, stateFile } = scratchRepo();
  const mcp = new LocalGitMCP(dir, stateFile);

  await mcp.callTool('create_branch', { branch: 'foreman/task-009' });
  await mcp.callTool('commit_files', {
    branch: 'foreman/task-009',
    files: [{ path: 'src/at-ref.mjs', content: 'export const marker = "at-ref";\n' }],
    message: 'add at-ref',
  });

  const diff = await mcp.callTool('get_branch_diff', { branch: 'foreman/task-009' });
  assert.match(diff, /at-ref\.mjs/);

  const content = await mcp.callTool('read_file_at_ref', { branch: 'foreman/task-009', path: 'src/at-ref.mjs' });
  assert.match(content, /at-ref/);

  const missing = await mcp.callTool('read_file_at_ref', { branch: 'foreman/task-009', path: 'src/absent.mjs' });
  assert.equal(missing, null);
});

test('local-git: agent-supplied paths cannot escape the repository', async () => {
  const { dir, stateFile } = scratchRepo();
  const mcp = new LocalGitMCP(dir, stateFile);
  await mcp.callTool('create_branch', { branch: 'foreman/evil' });

  for (const evil of ['../outside.mjs', '/etc/passwd', 'a/../../b.mjs']) {
    await assert.rejects(
      () =>
        mcp.callTool('commit_files', {
          branch: 'foreman/evil',
          files: [{ path: evil, content: 'pwned\n' }],
          message: 'escape attempt',
        }),
      /escapes repository|invalid repo path/,
      `expected rejection for ${evil}`,
    );
  }
  // symlink escape: a directory inside the repo pointing outside
  fs.mkdirSync(path.join(dir, 'link'));
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'top secret\n');
  fs.symlinkSync(path.join(path.dirname(dir), `${path.basename(dir)}-state.json`), path.join(dir, 'link', 'state'));
  await assert.rejects(
    () =>
      mcp.callTool('commit_files', {
        branch: 'foreman/evil',
        files: [{ path: 'link/state', content: 'overwrite via symlink\n' }],
        message: 'symlink escape attempt',
      }),
    /escapes repository/,
  );
});

test('local-git: a broken diff fails closed instead of reading as "no changes"', async () => {
  const { dir, stateFile } = scratchRepo();
  const mcp = new LocalGitMCP(dir, stateFile);
  await mcp.callTool('create_pull_request', { branch: 'no-such-branch', title: 'ghost PR' });
  await assert.rejects(() => mcp.callTool('get_branch_diff', { branch: 'no-such-branch' }));
  await assert.rejects(() => mcp.callTool('get_pull_request_diff', { number: 1 }));
});

test('rate limiter: bursts beyond capacity serialize instead of failing', async () => {
  const rl = new RateLimiter({ capacity: 3, refillPerSec: 1000, maxAttempts: 2 });
  let concurrent = 0;
  let peak = 0;
  const op = async () => {
    concurrent++; peak = Math.max(peak, concurrent);
    await new Promise((r) => setTimeout(r, 5));
    concurrent--;
    return true;
  };
  await Promise.all(Array.from({ length: 8 }, () => rl.run(op)));
  assert.ok(peak <= 3, `peak concurrency ${peak} must respect bucket size`);
});

test('rate limiter: rate-limit errors are retried with backoff', async () => {
  const rl = new RateLimiter({ capacity: 10, refillPerSec: 1000, maxAttempts: 3 });
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls < 3) throw new Error('HTTP 429: secondary rate limit exceeded');
    return 'ok';
  };
  assert.equal(await rl.run(flaky), 'ok');
  assert.equal(calls, 3);
});

test('github facade: local backend by default, remote when MCP command set', async () => {
  const config = loadConfig({ ...process.env });
  config.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-gh-'));
  config.targetLocal = config.dataDir;
  const auditStub = { record() {} };
  const gh = new GitHubMCP({ config, audit: auditStub });
  assert.equal(gh.backendKind, 'local');
  assert.ok(gh.local instanceof LocalGitMCP);
});

test('github facade: merge is refused without a satisfied T2 approval', async () => {
  const config = loadConfig({ ...process.env });
  config.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-gh2-'));
  config.targetLocal = config.dataDir;
  const audited = [];
  const gh = new GitHubMCP({ config, audit: { record: (e) => audited.push(e) } });

  await assert.rejects(
    () => gh.mergePR(1),
    (e) => e.code === 'APPROVAL_REQUIRED',
    'merge without authorization must be structurally impossible',
  );
  await assert.rejects(() => gh.closeIssue(1), (e) => e.code === 'APPROVAL_REQUIRED');
  assert.equal(audited.length, 0, 'refused calls never reach the backend');

  // with authorization the call goes through (local backend merges nothing
  // here — use a nonexistent PR to prove the call REACHED the backend)
  await assert.rejects(
    () => gh.mergePR(999, { approvalId: 'appr-0001', decidedBy: 'human:alice' }),
    /not found/,
  );
  assert.ok(audited.some((e) => e.action === 'merge_pull_request' && e.tier === 'T2'));
});

test('github facade: remote arg translation injects repo identity and maps field names', () => {
  const config = loadConfig({
    ...process.env,
    FOREMAN_TARGET_GITHUB: 'acme/widgets',
    FOREMAN_MCP_COMMAND: '/bin/true',
    GITHUB_PERSONAL_ACCESS_TOKEN: 'stub',
  });
  config.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-gh3-'));
  const gh = new GitHubMCP({ config, audit: { record() {} } });
  assert.equal(gh.backendKind, 'remote');

  assert.deepEqual(gh._translateArgs('create_pull_request', { branch: 'foreman/t1', title: 'x' }), {
    owner: 'acme', repo: 'widgets', head: 'foreman/t1', base: 'main', title: 'x', body: '',
  });
  assert.deepEqual(gh._translateArgs('get_pull_request', { number: '7' }), {
    owner: 'acme', repo: 'widgets', pullNumber: 7,
  });
  assert.deepEqual(gh._translateArgs('close_issue', { number: 3 }), {
    owner: 'acme', repo: 'widgets', issue_number: 3, state: 'closed',
  });
  return gh.close();
});
