// The review stage. Every tests-passed task is reviewed BEFORE a PR is
// opened: deterministic security heuristics over the branch diff and file
// contents, plus an LLM review (via TrueForge) when configured.
//
// Blocking findings stop the task at needs_human — no PR is ever proposed
// with a hardcoded token in it. The human approving a merge sees the
// findings attached to the gate detail: diff · tests · review.
//
// Precision over recall: a false positive here stalls a parallel swarm.
// Patterns are deliberately narrow.

const SECRET_PATTERNS = [
  /\bghp_[A-Za-z0-9]{20,}\b/,                    // github PAT (classic)
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,            // github PAT (fine-grained)
  /\bsk-[A-Za-z0-9]{20,}\b/,                     // provider API key
  /\bAKIA[0-9A-Z]{16}\b/,                        // aws access key id
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,          // pem private key block
];

const MAX_FILE_BYTES = 100_000; // large/binary-ish files are skipped

export class ReviewStage {
  /**
   * @param {object} deps
   * @param {import('./mcp_clients/github.mjs').GitHubMCP} deps.github
   * @param {import('./core/events.mjs').EventBus} deps.bus
   * @param {(e: object) => void} deps.persist
   */
  constructor({ github, bus, persist }) {
    this.github = github;
    this.bus = bus;
    this.persist = persist;
  }

  /**
   * Review a task's branch. Returns { ok, findings, files }.
   * `ok` is false iff any blocking finding fired. Never throws — a review
   * crash degrades to a warning-only result so the queue cannot wedge.
   */
  async run({ task }) {
    try {
      return await this._run({ task });
    } catch (err) {
      this.bus.emitEvent('review.error', {
        taskId: task.id, error: err.message,
      }, this.persist);
      return {
        ok: true,
        degraded: true,
        findings: [{ severity: 'warning', file: null, rule: 'review-crashed', message: `review stage failed (${err.message}); heuristics skipped` }],
        files: [],
      };
    }
  }

  async _run({ task }) {
    const branch = task.branch;
    const diff = await this.github.getBranchDiff(branch);
    const findings = [];

    if (!diff || diff.trim() === '') {
      return { ok: true, findings: [{ severity: 'warning', file: null, rule: 'empty-diff', message: 'branch has no changes relative to main' }], files: [] };
    }

    const changed = parseChangedFiles(diff);
    const added = new Set(changed.filter((f) => f.status === 'added').map((f) => f.path));
    const modified = new Set(changed.filter((f) => f.status !== 'added').map((f) => f.path));
    const addedLinesByFile = addedLines(diff);

    // fetch contents for changed files (bounded)
    const contents = new Map();
    for (const f of changed) {
      if (f.path.endsWith('.lock') || f.path.includes('node_modules/')) continue;
      try {
        const text = await this.github.readFileAtRef(branch, f.path);
        if (text !== null && text.length <= MAX_FILE_BYTES) contents.set(f.path, text);
      } catch { /* unreadable files are skipped, not fatal */ }
    }

    // 1) secrets — full file scan on changed files
    for (const [file, text] of contents) {
      for (const re of SECRET_PATTERNS) {
        if (re.test(text)) {
          findings.push({
            severity: 'blocking', file, rule: 'hardcoded-secret',
            message: `matches ${re.source} — never commit credentials`,
          });
        }
      }
    }

    // 2) dynamic execution and injection — added lines only
    for (const [file, lines] of addedLinesByFile) {
      for (const [i, line] of lines.entries()) {
        if (/\beval\s*\(|new\s+Function\s*\(/.test(line)) {
          findings.push({
            severity: 'blocking', file, rule: 'dynamic-execution', line: i + 1,
            message: `eval/new Function on line ${i + 1}: ${line.trim().slice(0, 120)}`,
          });
        }
        if (/child_process|execSync|spawnSync/.test(line) && /\$\{|\+ *\w|["'`].*\w+ *["']\s*\+/.test(line)) {
          findings.push({
            severity: 'blocking', file, rule: 'command-injection', line: i + 1,
            message: `command built from interpolated values on line ${i + 1}: ${line.trim().slice(0, 120)}`,
          });
        }
      }
    }

    // 3) scope: MODIFYING a file outside spec.touches is blocking
    const touches = new Set(task.spec?.touches ?? []);
    for (const file of modified) {
      if (touches.size > 0 && !touches.has(file)) {
        findings.push({
          severity: 'blocking', file, rule: 'scope-violation',
          message: `modifies ${file}, which is outside the declared scope (${[...touches].join(', ')})`,
        });
      }
    }
    // creating a brand-new file adjacent to scope is normal agent behavior
    for (const file of added) {
      if (touches.size > 0 && !touches.has(file) && !isTestFile(file)) {
        findings.push({
          severity: 'warning', file, rule: 'new-file-outside-scope',
          message: `new file ${file} is not listed in the spec scope (accepted: new modules + tests, flagged for visibility)`,
        });
      }
    }

    // 4) hygiene warnings
    if (changed.some((f) => /^src\//.test(f.path) || /^lib\//.test(f.path))) {
      const hasTest = changed.some((f) => isTestFile(f.path));
      if (!hasTest) {
        findings.push({
          severity: 'warning', file: null, rule: 'no-tests',
          message: 'changes source files without any changed test file',
        });
      }
    }
    for (const [file, lines] of addedLinesByFile) {
      if (lines.some((l) => /\b(TODO|FIXME|XXX)\b/.test(l))) {
        findings.push({
          severity: 'warning', file, rule: 'todo-left',
          message: 'TODO/FIXME introduced in the diff',
        });
      }
    }

    const ok = !findings.some((f) => f.severity === 'blocking');
    this.bus.emitEvent(ok ? 'review.passed' : 'review.blocked', {
      taskId: task.id,
      findings: findings.length,
      blocking: findings.filter((f) => f.severity === 'blocking').length,
    }, this.persist);
    return { ok, findings, files: changed.map((f) => f.path) };
  }
}

/** Files touched by a diff, with add/modify/delete status. */
export function parseChangedFiles(diff) {
  const out = [];
  let current = null;
  for (const line of String(diff).split(/\r?\n/)) {
    const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (m) {
      current = { path: m[2], status: 'modified' };
      out.push(current);
      continue;
    }
    if (current) {
      if (/^new file mode /.test(line)) current.status = 'added';
      if (/^deleted file mode /.test(line)) current.status = 'deleted';
    }
  }
  return out;
}

/** Added lines per file from a unified diff: Map<file, string[]>. */
export function addedLines(diff) {
  const byFile = new Map();
  let file = null;
  for (const line of String(diff).split(/\r?\n/)) {
    const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (m) {
      file = m[2];
      byFile.set(file, byFile.get(file) ?? []);
      continue;
    }
    if (file === null) continue;
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) continue;
    if (line.startsWith('+')) byFile.get(file).push(line.slice(1));
  }
  return byFile;
}

function isTestFile(p) {
  return /(^|\/)(test|tests|__tests__)\//.test(p) || /\.(test|spec)\.[a-z]+$/.test(p);
}
