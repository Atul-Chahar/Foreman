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
  commit_files: null, // remote backend composes it from per-file calls below
  create_issue: 'create_issue',
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
        // compose commit_files remotely from create_or_update_file calls
        if (tool === 'commit_files') return this._remoteCommitFiles(args);
        return { ok: true };
      }
      const res = await this.remote.callTool(remoteName, args);
      return JSON.parse(findText(res) ?? 'null');
    });
  }

  async _remoteCommitFiles({ branch, files, message }) {
    if (!this.owner || !this.repo) {
      throw new Error('FOREMAN_TARGET_GITHUB must be owner/repo for the remote MCP backend');
    }
    for (const f of files) {
      await this.remote.callTool('create_or_update_file', {
        owner: this.owner, repo: this.repo, path: f.path, branch, message,
        content: encodeBase64(f.content),
      });
    }
    return { branch, committed: files.length };
  }

  // ── typed helpers the harness actually uses ──────────────────────────────

  listIssues() { return this.call('list_issues', {}, { tier: 'T0' }); }
  getIssue(number) { return this.call('get_issue', { number }, { tier: 'T0' }); }
  createBranch(branch, fromRef = 'main') { return this.call('create_branch', { branch, fromRef }, { tier: 'T1' }); }
  commitFiles(branch, files, message) { return this.call('commit_files', { branch, files, message }, { tier: 'T1' }); }
  createPR(branch, title, body) { return this.call('create_pull_request', { branch, title, body }, { tier: 'T1' }); }
  getPR(number) { return this.call('get_pull_request', { number }, { tier: 'T0' }); }
  getPRDiff(number) { return this.call('get_pull_request_diff', { number }, { tier: 'T0' }); }
  mergePR(number) { return this.call('merge_pull_request', { number }, { tier: 'T2' }); }
  closeIssue(number) { return this.call('close_issue', { number }, { tier: 'T2' }); }
}

function findText(res) {
  const part = (res?.content ?? []).find((c) => c.type === 'text');
  return part?.text ?? null;
}

function encodeBase64(s) {
  return Buffer.from(s, 'utf8').toString('base64');
}
