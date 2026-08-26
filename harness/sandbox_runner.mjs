// The sandbox. This is where agent-written code is allowed to execute —
// and the ONLY place. The orchestrator never evals, never shells out to
// agent-provided strings on its own tree; it hands the sandbox a branch and
// a test command, and gets back a structured result.
//
// Isolation properties:
//   - the code runs in a disposable `git worktree` checkout of the task
//     branch — a separate directory and index, not the orchestrator's tree
//   - the command is parsed and matched against an allowlist of test
//     runners (node --test / npm test / pnpm test / pytest …); anything
//     else is refused before spawn — no shell, no pipes, no chaining
//   - a hard timeout kills hung test runs; nothing holds a slot forever
//   - the process env is scrubbed: secrets available to the orchestrator
//     are NOT inherited by sandboxed code
//
// When FOREMAN_TRUEFORGE_URL is set, execution is delegated to the
// TrueForge sandbox API instead (see harness/subagents/dispatcher.mjs);
// the local worktree backend below is the always-available default.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ALLOWED_RUNNERS = [
  'node', 'npm', 'pnpm', 'yarn', 'bun', // js
  'pytest', 'python', 'python3',       // py
  'go',                                // go
];

/** Dangerous characters that would turn a single command into a pipeline. */
const SHELL_METACHARS = /[;&|<>`$\n\r\\]/;

export class SandboxRunner {
  /**
   * @param {object} opts
   * @param {string} opts.repoDir the target repo (worktrees are carved out of it)
   * @param {string} opts.sandboxRoot directory under which worktrees are created
   * @param {number} [opts.timeoutMs] hard cap per run (default: agent timeout)
   */
  constructor({ repoDir, sandboxRoot, timeoutMs = 300_000 }) {
    this.repoDir = repoDir;
    this.sandboxRoot = sandboxRoot;
    this.timeoutMs = timeoutMs;
    fs.mkdirSync(sandboxRoot, { recursive: true });
  }

  /**
   * Check out `branch` into a fresh worktree and run `command` there.
   *
   * @param {{branch: string, command: string, taskId?: string}} spec
   * @returns {Promise<{ok: boolean, exitCode: number|null, stdout: string, stderr: string, durationMs: number, worktree: string, timedOut: boolean, refused?: string}>}
   */
  async exec({ branch, command, taskId }) {
    const parsed = parseCommand(command);
    const refusal = validateCommand(parsed);
    if (refusal) {
      return {
        ok: false, exitCode: null, stdout: '', stderr: '', durationMs: 0,
        worktree: null, timedOut: false, refused: refusal,
      };
    }

    const worktree = await this.createWorktree(branch, taskId);
    const started = Date.now();
    try {
      const result = await this._spawn(parsed, worktree);
      return {
        ...result,
        ok: result.exitCode === 0 && !result.timedOut,
        durationMs: Date.now() - started,
        worktree,
      };
    } finally {
      // keep the worktree around on failure for inspection? no — logs are
      // captured; a lingering worktree would leak disk across a long run
      await this.destroyWorktree(worktree);
    }
  }

  _spawn(parsed, cwd) {
    return new Promise((resolve) => {
      // scrub env: sandboxed code sees no orchestrator secrets
      const env = {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        COMSPEC: process.env.COMSPEC,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
        APPDATA: process.env.APPDATA,
        LOCALAPPDATA: process.env.LOCALAPPDATA,
        FOREMAN_SANDBOX: '1',
      };
      const { bin, args } = this._resolveSpawn(parsed);
      // detached on posix => its own process group, so a timeout can kill
      // the whole tree (test runners spawn children all the time)
      const child = spawn(bin, args, {
        cwd, env, windowsHide: true, shell: false,
        detached: process.platform !== 'win32',
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, this.timeoutMs);

      child.stdout.on('data', (d) => { if (stdout.length < 200_000) stdout += d; });
      child.stderr.on('data', (d) => { if (stderr.length < 200_000) stderr += d; });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ exitCode: null, stdout, stderr: `${stderr}${err.message}`, timedOut });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code, stdout, stderr, timedOut });
      });
    });
  }

  /**
   * Windows package managers are .cmd shims, which cannot be spawned with
   * shell:false. Tokens are already metachar-free (validateCommand), so
   * routing them through cmd.exe is not an injection surface. The `node`
   * runner — the default — never goes through cmd.
   */
  _resolveSpawn({ bin, args }) {
    if (process.platform === 'win32' && ['npm', 'pnpm', 'yarn', 'bun'].includes(bin)) {
      return { bin: 'cmd.exe', args: ['/d', '/s', '/c', bin, ...args] };
    }
    return { bin, args };
  }

  // ── worktree lifecycle ────────────────────────────────────────────────────

  async createWorktree(branch, taskId = 'adhoc') {
    const name = `sbx-${taskId}-${Date.now().toString(36)}`;
    const wt = path.join(this.sandboxRoot, name);
    const r = spawnSync('git', ['-C', this.repoDir, 'worktree', 'add', '--detach', wt, branch], {
      encoding: 'utf8', windowsHide: true,
    });
    if (r.status !== 0) throw new Error(`worktree add failed: ${(r.stderr || '').trim()}`);
    return wt;
  }

  async destroyWorktree(wt) {
    if (!wt || !fs.existsSync(wt)) return true;
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = spawnSync('git', ['-C', this.repoDir, 'worktree', 'remove', '--force', wt], {
        encoding: 'utf8', windowsHide: true,
      });
      if (r.status === 0) return true;
    }
    // A leaked worktree holds a branch lock and disk forever — that must be
    // loud, not silently swallowed.
    console.error(`[sandbox] FAILED to remove worktree ${wt} — manual cleanup required`);
    return false;
  }
}

/**
 * Parse a test command into {bin, args}. Throws on empty input; callers
 * validate before spawning.
 */
export function parseCommand(command) {
  const tokens = String(command ?? '').trim().split(/\s+/);
  const [bin, ...args] = tokens;
  return { bin: bin || '', args };
}

/** Return a refusal reason, or null when the command is sandbox-safe. */
export function validateCommand({ bin, args }) {
  if (!bin) return 'empty command';
  if (SHELL_METACHARS.test(bin) || args.some((a) => SHELL_METACHARS.test(a))) {
    return 'shell metacharacters are not allowed in sandbox commands';
  }
  if (!ALLOWED_RUNNERS.includes(bin)) {
    return `runner '${bin}' is not on the sandbox allowlist (${ALLOWED_RUNNERS.join(', ')})`;
  }
  // Per-runner shape checks: an allowlisted binary with arbitrary arguments
  // is still arbitrary execution (node -e, npm exec, go run …).
  if (bin === 'node') {
    const evalish = args.some((a) => /^(-e|-p|--eval|--print)$/.test(a));
    const testish = args.some((a) => a === '--test' || a.includes('.test.') || a.includes('test'));
    if (evalish || !testish) return 'node commands in the sandbox must target tests';
  }
  if (['npm', 'pnpm', 'yarn'].includes(bin)) {
    // only the project's own test script: "npm test" / "npm run test"
    const ok =
      (args[0] ?? '').toLowerCase() === 'test' ||
      ((args[0] ?? '').toLowerCase() === 'run' && (args[1] ?? '').toLowerCase() === 'test');
    if (!ok) return `${bin} in the sandbox may only run the project's test script`;
  }
  if (bin === 'bun' && (args[0] ?? '') !== 'test') {
    return 'bun in the sandbox may only run "bun test"';
  }
  if (bin === 'go' && (args[0] ?? '') !== 'test') {
    return 'go in the sandbox may only run "go test"';
  }
  if (['python', 'python3'].includes(bin)) {
    const testish = args.some((a) => a.includes('test'));
    if (!testish) return 'python commands in the sandbox must target tests';
  }
  const lowers = args.map((a) => a.toLowerCase());
  if (lowers.includes('rm') || lowers.includes('del') || lowers.includes('rmdir')) {
    return 'filesystem deletion is not allowed in the sandbox';
  }
  return null;
}

/** Kill a child and its DESCENDANTS: SIGKILL to the process group on posix
 *  (spawn used detached), taskkill /T on Windows. Killing only the immediate
 *  runner would orphan whatever the runner spawned. */
function killTree(child) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL'); // negative pid = the whole group
    } catch {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }
}
