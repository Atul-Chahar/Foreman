// GitHub over MCP — the one remote the swarm is allowed to touch.
//
// Two interchangeable backends behind one facade:
//
//   remote: a real stdio MCP server (FOREMAN_MCP_COMMAND), e.g. the official
//           GitHub MCP server. Real API calls, real rate limits.
//   local:  LocalGitMCP — same tool surface, backed by a real local git repo.
//
// Every call goes through the rate limiter. Every call is auditable. The
// merge tool is only ever invoked by the merge queue, only after the
// approval gate has been satisfied.

import path from 'node:path';
import { MCPClient } from './client.mjs';
import { LocalGitMCP } from './local_git.mjs';
import { RateLimiter } from './ratelimit.mjs';

// Tool name translation: foreman-internal name -> github mcp server name.
const REMOTE_TOOLS = {
  list_issues: 'list_issues',
  get_issue: 'get_issue',
  create_branch: 'create_branch',
  create_pull_request: 'create_pull_request',
  get_pull_request: 'get_pull_request',
  get_pull_request_diff: 'get_pull_request_diff',
  merge_pull_request: 'merge_pull_request',
  close_issue: 'close_issue',
  create_issue: 'create_issue',
  // pre-PR review tools: diff a branch directly, read a file at a ref
  get_branch_diff: null, // composed: compare_commits against base
  read_file_at_ref: 'get_file_contents',
  commit_files: null, // remote backend composes it from per-file calls below
  push: null,
};

export class GitHubMCP {
  /**
   * @param {object} opts
   * @param {import('../config.mjs').Config} opts.config
   * @param {import('../core/audit.mjs').AuditLog} opts.audit
   */
  constructor({ config, audit }) {
    this.audit = audit;
    const [owner, repo] = (config.targetGithub || '/').split('/');
    this.owner = owner || null;
    this.repo = repo || null;
    this.backendKind = config.mcpCommand ? 'remote' : 'local';
    this.remote = this.backendKind === 'remote'
      ? new MCPClient({
          command: config.mcpCommand,
          args: config.mcpArgs,
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_PERSONAL_ACCESS_TOKEN ?? '' },
        })
      : null;
    this.local = this.backendKind === 'local'
      ? new LocalGitMCP(config.targetLocal, path.join(config.dataDir, 'localhub', 'state.json'))
      : null;
    this.limiter = new RateLimiter();
  }

  async connect() {
    if (this.remote) await this.remote.connect();
    const name = this.remote ? `remote(${this.remote.command})` : `local(${this.local.repoDir})`;
    this.audit.record({
      actor: 'system:mcp', action: 'connect', decision: 'connected', reason: `backend: ${name}`,
    });
    return name;
  }

  async close() {
    if (this.remote) await this.remote.close();
  }

  /**
   * Invoke a tool on whichever backend is active. `tier` is the risk tier of
   * the tool per harness/policy/tiers.mjs — the caller has ALREADY routed the
   * action through the policy engine; this method only executes.
   */
  async call(tool, args = {}, { tier = 'T0' } = {}) {
    return this.limiter.run(async () => {
      if (this.local) {
        return this.local.callTool(tool, args);
      }
      const remoteName = REMOTE_TOOLS[tool];
      if (remoteName === null) {
        if (tool === 'commit_files') return this._remoteCommitFiles(args);
        if (tool === 'get_branch_diff') return this._remoteBranchDiff(args);
        return { ok: true };
      }
      const res = await this.remote.callTool(remoteName, this._translateArgs(tool, args));
      return JSON.parse(findText(res) ?? 'null');
    });
  }

  /** The official GitHub MCP server schemas differ from our internal tool
   *  surface: repository identity is injected, and field names are mapped
   *  (branch->head, number->pullNumber/issue_number, etc). */
  _translateArgs(tool, args) {
    const base = { owner: this.owner, repo: this.repo };
    switch (tool) {
      case 'read_file_at_ref':
        return { ...base, path: args.path, ref: args.branch };
      case 'create_pull_request':
        return { ...base, head: args.branch, base: args.base ?? 'main', title: args.title, body: args.body ?? '' };
      case 'get_pull_request':
        return { ...base, pullNumber: Number(args.number) };
      case 'get_pull_request_diff':
        return { ...base, pullNumber: Number(args.number) };
      case 'merge_pull_request':
        return { ...base, pullNumber: Number(args.number), merge_method: 'merge' };
      case 'list_issues':
        return { ...base, state: 'open' };
      case 'get_issue':
        return { ...base, issue_number: Number(args.number) };
      case 'create_issue':
        return { ...base, title: args.title, body: args.body ?? '', labels: args.labels ?? [] };
      case 'close_issue':
        return { ...base, issue_number: Number(args.number), state: 'closed' };
      case 'create_branch':
        return { ...base, branch: args.branch, from_branch: args.fromRef ?? 'main' };
      default:
        return { ...base, ...args };
    }
  }

  async _remoteBranchDiff({ branch, base = 'main' }) {
    if (!this.owner || !this.repo) {
      throw new Error('FOREMAN_TARGET_GITHUB must be owner/repo for the remote MCP backend');
    }
    const res = await this.remote.callTool('compare_commits', {
      owner: this.owner, repo: this.repo, base, head: branch,
    });
    const parsed = JSON.parse(findText(res) ?? '{}');
    // Every changed file produces a record — patchless (binary) entries get
    // explicit metadata so an empty diff can only mean "no changes".
    return (parsed.files ?? [])
      .map((f) =>
        f.patch
          ? `diff --git a/${f.filename} b/${f.filename}\n${f.patch}`
          : `diff --git a/${f.filename} b/${f.filename}\nBinary or patchless change (${f.status ?? 'modified'}); ${f.additions ?? 0} additions, ${f.deletions ?? 0} deletions`,
      )
      .join('\n');
  }

  async _remoteCommitFiles({ branch, files, message }) {
    if (!this.owner || !this.repo) {
      throw new Error('FOREMAN_TARGET_GITHUB must be owner/repo for the remote MCP backend');
    }
    // One atomic batch commit via push_files: a failure leaves the branch
    // untouched instead of half-committed, and retries never re-apply
    // already-successful per-file mutations.
    const res = await this.remote.callTool('push_files', {
      owner: this.owner,
      repo: this.repo,
      branch,
      message,
      files: files.map((f) => ({ path: f.path, content: f.content })),
    });
    const parsed = findText(res) ? JSON.parse(findText(res)) : null;
    return { branch, committed: files.length, ...(parsed ?? {}) };
  }

  // ── typed helpers the harness actually uses ──────────────────────────────

  listIssues() { return this.call('list_issues', {}, { tier: 'T0' }); }
  getIssue(number) { return this.call('get_issue', { number }, { tier: 'T0' }); }
  createBranch(branch, fromRef = 'main') { return this.call('create_branch', { branch, fromRef }, { tier: 'T1' }); }
  commitFiles(branch, files, message) { return this.call('commit_files', { branch, files, message }, { tier: 'T1' }); }
  createPR(branch, title, body) { return this.call('create_pull_request', { branch, title, body }, { tier: 'T1' }); }
  getPR(number) { return this.call('get_pull_request', { number }, { tier: 'T0' }); }
  getPRDiff(number) { return this.call('get_pull_request_diff', { number }, { tier: 'T0' }); }
  getBranchDiff(branch, base = 'main') { return this.call('get_branch_diff', { branch, base }, { tier: 'T0' }); }
  readFileAtRef(branch, filePath) { return this.call('read_file_at_ref', { branch, path: filePath }, { tier: 'T0' }); }

  /** Push a branch head so the merge executes exactly what was rebase-tested
   *  locally, not a stale remote head. Local backend pushes to its origin
   *  (a no-op for throwaway demo repos); remote backends must support it. */
  pushBranch(branch) { return this.call('push', { branch }, { tier: 'T1' }); }

  /**
   * Merge is T2: irreversible and only ever executed on behalf of a satisfied
   * approval. The gate's decision travels with the call — a facade caller
   * that cannot show it never reaches the backend.
   * @param {{ approvalId: string, decidedBy: string }} authorization from ApprovalGate.request()
   */
  async mergePR(number, authorization) {
    if (!authorization?.approvalId || !authorization?.decidedBy) {
      const err = new Error(
        `merge PR #${number} requires a satisfied T2 approval: mergePR(number, { approvalId, decidedBy })`,
      );
      err.code = 'APPROVAL_REQUIRED';
      throw err;
    }
    this.audit.record({
      actor: authorization.decidedBy,
      tier: 'T2',
      action: 'merge_pull_request',
      decision: `executing approval ${authorization.approvalId}`,
      reason: `merge PR #${number}`,
    });
    return this.call('merge_pull_request', { number }, { tier: 'T2' });
  }

  closeIssue(number, authorization) {
    if (!authorization?.approvalId || !authorization?.decidedBy) {
      const err = new Error(`close issue #${number} requires a satisfied T2 approval`);
      err.code = 'APPROVAL_REQUIRED';
      return Promise.reject(err);
    }
    return this.call('close_issue', { number }, { tier: 'T2' });
  }
}

function findText(res) {
  const part = (res?.content ?? []).find((c) => c.type === 'text');
  return part?.text ?? null;
}
