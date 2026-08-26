// LocalGit: the offline MCP backend. Implements EXACTLY the same tool
// surface as the GitHub MCP server, but the "remote" repo is a real local
// git repository — branches, commits, diffs, and merges are real git
// operations, not mocks. Issues and PRs live in a small state file, because
// plain git has no issue tracker.
//
// This exists so the entire swarm path (dispatch -> sandbox -> PR -> gate ->
// merge -> reconciler) runs with zero credentials. Point
// FOREMAN_MCP_COMMAND at the real GitHub MCP server for production.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BOT_IDENTITY = ['-c', 'user.name=foreman-bot', '-c', 'user.email=bot@foreman.local'];

export class LocalGitMCP {
  /**
   * @param {string} repoDir path to the git working tree the swarm targets
   * @param {string} stateFile where issues/PRs are tracked
   */
  constructor(repoDir, stateFile) {
    this.repoDir = repoDir;
    this.stateFile = stateFile;
    this._state = null;
  }

  get name() {
    return 'local-git';
  }

  // ── state (issues + PR bookkeeping) ───────────────────────────────────────

  _load() {
    if (this._state) return this._state;
    if (fs.existsSync(this.stateFile)) {
      this._state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    } else {
      this._state = { issues: [], prs: [], nextIssue: 1, nextPr: 1 };
    }
    return this._state;
  }

  _save() {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile, JSON.stringify(this._state, null, 2));
  }

  // ── tool surface (same names as the GitHub MCP server) ───────────────────

  async callTool(name, args = {}) {
    const impl = this[name];
    if (typeof impl !== 'function') {
      throw new Error(`local-git MCP: unknown tool ${name}`);
    }
    return impl.call(this, args);
  }

  /** [{number, title, body, state, labels}] */
  async list_issues() {
    return this._load().issues.filter((i) => i.state === 'open');
  }

  async get_issue({ number }) {
    const issue = this._load().issues.find((i) => i.number === Number(number));
    if (!issue) throw new Error(`issue #${number} not found`);
    return issue;
  }

  async create_issue({ title, body = '', labels = [] }) {
    const s = this._load();
    const issue = { number: s.nextIssue++, title, body, labels, state: 'open' };
    s.issues.push(issue);
    this._save();
    return issue;
  }

  async close_issue({ number }) {
    const issue = await this.get_issue({ number });
    issue.state = 'closed';
    this._save();
    return issue;
  }

  async create_branch({ branch, fromRef = 'main' }) {
    this._git(['fetch', 'origin'], { allowFail: true }); // no-op locally
    this._git(['checkout', '-B', branch, fromRef]);
    this._git(['checkout', 'main']);
    return { branch, from: fromRef };
  }

  async commit_files({ branch, files, message }) {
    this._git(['checkout', branch]);
    for (const f of files) {
      const abs = this._safePath(f.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, f.content);
      this._git(['add', f.path]);
    }
    this._git([...BOT_IDENTITY, 'commit', '--allow-empty', '-m', message]);
    this._git(['checkout', 'main']);
    const head = this._git(['rev-parse', branch]).stdout.trim();
    return { branch, head, committed: files.length };
  }

  /**
   * Resolve an agent-supplied path against the repo root, refusing anything
   * that could write outside the tree: absolute paths, `..` traversal, or a
   * symlinked directory pointing elsewhere.
   */
  _safePath(p) {
    if (typeof p !== 'string' || p.length === 0 || path.isAbsolute(p)) {
      throw new Error(`invalid repo path: ${JSON.stringify(p)}`);
    }
    const root = path.resolve(this.repoDir);
    const abs = path.resolve(root, p);
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`repo path escapes repository: ${p}`);
    }
    // Walk every component with lstat: a symlink anywhere along the route
    // (even a dangling one, which existsSync silently ignores) could redirect
    // the write outside the tree.
    let cur = root;
    for (const part of rel.split(path.sep)) {
      cur = path.join(cur, part);
      let st;
      try {
        st = fs.lstatSync(cur);
      } catch {
        continue; // component doesn't exist yet — nothing to follow
      }
      if (st.isSymbolicLink()) {
        let real;
        try {
          real = fs.realpathSync(cur);
        } catch {
          // dangling symlink: target missing, destination unknowable — refuse
          throw new Error(`repo path escapes repository through symlink: ${p}`);
        }
        if (real !== root && !real.startsWith(root + path.sep)) {
          throw new Error(`repo path escapes repository through symlink: ${p}`);
        }
      }
    }
    return abs;
  }

  async create_pull_request({ branch, title, body = '', base = 'main' }) {
    const s = this._load();
    const existing = s.prs.find((p) => p.branch === branch && p.state === 'open');
    if (existing) return existing; // idempotent: one PR per branch
    const pr = {
      number: s.nextPr++,
      branch,
      base,
      title,
      body,
      state: 'open',
      merged: false,
    };
    s.prs.push(pr);
    this._save();
    return pr;
  }

  async get_pull_request({ number }) {
    const pr = this._load().prs.find((p) => p.number === Number(number));
    if (!pr) throw new Error(`PR #${number} not found`);
    return { ...pr, diff: await this.get_pull_request_diff({ number }) };
  }

  async get_pull_request_diff({ number }) {
    const pr = this._load().prs.find((p) => p.number === Number(number));
    if (!pr) throw new Error(`PR #${number} not found`);
    // Fail closed: the review stage must never read a git error as "no
    // changes". A broken diff is an exception, not an empty string.
    return this._git(['diff', `${pr.base}...${pr.branch}`]).stdout;
  }

  /** Diff a branch against base without needing a PR. Review runs pre-PR. */
  async get_branch_diff({ branch, base = 'main' }) {
    return this._git(['diff', `${base}...${branch}`]).stdout;
  }

  /** File contents at a branch ref; null when the file does not exist there. */
  async read_file_at_ref({ branch, path: filePath }) {
    const r = this._git(['show', `${branch}:${filePath}`], { allowFail: true });
    if (r.status !== 0) return null;
    return r.stdout;
  }

  /** Real merge into main. Conflicts throw — the merge queue marks the PR
   *  needs-human; nothing force-resolves a conflict, ever. */
  async merge_pull_request({ number }) {
    const s = this._load();
    const pr = s.prs.find((p) => p.number === Number(number));
    if (!pr) throw new Error(`PR #${number} not found`);
    if (pr.state !== 'open') throw new Error(`PR #${number} is ${pr.state}`);

    this._git(['checkout', pr.base]);
    const merged = this._git(
      [...BOT_IDENTITY, 'merge', '--no-ff', pr.branch, '-m', `Merge PR #${pr.number}: ${pr.title}`],
      { allowFail: true },
    );
    if (merged.status !== 0) {
      this._git(['merge', '--abort'], { allowFail: true });
      this._git(['checkout', 'main'], { allowFail: true });
      const conflictErr = new Error(
        `merge conflict merging PR #${pr.number} (${pr.branch}) — needs human resolution`,
      );
      conflictErr.code = 'MERGE_CONFLICT';
      throw conflictErr;
    }
    pr.state = 'merged';
    pr.merged = true;
    this._save();
    return { number: pr.number, merged: true, head: this._git(['rev-parse', 'HEAD']).stdout.trim() };
  }

  async push({ branch }) {
    if (branch) {
      // best effort: demo repos often have no configured origin — the local
      // backend's merge reads the LOCAL branch head either way
      const r = this._git(['push', 'origin', branch], { allowFail: true });
      if (r.status === 0) return { ok: true, pushed: branch };
      return { ok: true, note: `no remote configured; kept local head for ${branch}` };
    }
    return { ok: true, note: 'local adapter: bare push is a no-op' };
  }

  // ── git plumbing ──────────────────────────────────────────────────────────

  _git(args, { allowFail = false } = {}) {
    const r = spawnSync('git', ['-C', this.repoDir, ...args], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (r.status !== 0 && !allowFail) {
      throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim()}`);
    }
    return r;
  }
}
