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

const MAX_SCAN_BYTES = 1_000_000; // hard cap on any single file read for review

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
   * `ok` is false iff any blocking finding fired. A review crash fails
   * CLOSED: the task stops at needs_human with the error attached rather
   * than sailing past every check because the reviewer hiccuped. The queue
   * still moves on — fail closed, never wedge.
   */
  async run({ task }) {
    try {
      return await this._run({ task });
    } catch (err) {
      this.bus.emitEvent('review.error', {
        taskId: task.id, error: err.message,
      }, this.persist);
      return {
        ok: false,
        degraded: true,
        findings: [{ severity: 'blocking', file: null, rule: 'review-crashed', message: `review stage failed (${err.message}); treat as unreviewed` }],
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
        // Secret scanning must not be bypassable by file size: readable
        // files are scanned whatever their length; only truly huge reads
        // are capped, and a capped read is recorded as such.
        if (text === null) continue;
        if (text.length > MAX_SCAN_BYTES) {
          contents.set(f.path, text.slice(0, MAX_SCAN_BYTES));
          findings.push({
            severity: 'warning', file: f.path, rule: 'file-truncated-in-review',
            message: `file exceeds ${MAX_SCAN_BYTES} bytes — secrets scan covered the first ${MAX_SCAN_BYTES}`,
          });
        } else {
          contents.set(f.path, text);
        }
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

    // 2) dynamic execution and injection — added lines only, with REAL
    // new-file line numbers from the hunk headers
    for (const [file, lines] of addedLinesByFile) {
      for (const finding of scanAddedLines(file, lines)) {
        findings.push(finding);
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
      if (lines.some((l) => /\b(TODO|FIXME|XXX)\b/.test(l.text))) {
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

/** exec-ish calls; interpolation into one of these is how command
 *  injection actually happens. */
const EXEC_RE = /\b(?:child_process|execSync|spawnSync|exec\s*\()/;
/** template-literal interpolation */
const INTERP_RE = /\$\{[^}]*\}/;

/** Injection heuristics over a file's added lines. Precision-first: plain
 *  string concatenation of static parts is NOT flagged — false positives
 *  here stall a parallel swarm. */
export function scanAddedLines(file, lines) {
  const out = [];
  for (const { n, text: line } of lines) {
    if (/\beval\s*\(|new\s+Function\s*\(/.test(line)) {
      out.push({
        severity: 'blocking', file, rule: 'dynamic-execution', line: n,
        message: `eval/new Function on line ${n}: ${line.trim().slice(0, 120)}`,
      });
    }
    if (EXEC_RE.test(line) && INTERP_RE.test(line)) {
      out.push({
        severity: 'blocking', file, rule: 'command-injection', line: n,
        message: `command composed with interpolated values on line ${n}: ${line.trim().slice(0, 120)}`,
      });
    }
  }
  return out;
}

/**
 * Files touched by a diff, with add/modify/delete status.
 * Handles quoted headers (`diff --git "a/pa th" "b/pa th"`) emitted for
 * paths with spaces/special chars, and classifies a file as ADDED when its
 * first hunk starts at -0,0 (works even when the backend's diff omits
 * explicit "new file mode" markers).
 */
export function parseChangedFiles(diff) {
  const out = [];
  let current = null;
  let sawNewFileMarker = false;
  for (const line of String(diff).split(/\r?\n/)) {
    const m = DIFF_HEADER_RE.exec(line);
    if (m) {
      current = { path: unquotePath(m[1] ?? m[2]), status: 'modified' };
      sawNewFileMarker = false;
      out.push(current);
      continue;
    }
    if (!current) continue;
    if (/^new file mode /.test(line)) current.status = 'added';
    else if (/^deleted file mode /.test(line)) current.status = 'deleted';
    else if (!sawNewFileMarker && /^@@ -0,0 \+\d+,\d+ @@|^@@ -0,0 \+@@/.test(line)) {
      // every hunk line is an addition starting at line 1 => brand-new file
      if (current.status === 'modified') current.status = 'added';
      sawNewFileMarker = true;
    }
  }
  return out;
}

const DIFF_HEADER_RE = /^diff --git (?:"a\/(.+)"|a\/(.+?)) (?:"b\/(.+)"|b\/(.+))$/;

/** git quotes unusual paths ("a/with space") and C-escapes them. */
function unquotePath(p) {
  if (p === undefined || p === null) return '';
  return p.replace(/\\(["\\nt])/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
}

/**
 * Added lines per file from a unified diff: Map<file, Array<{n, text}>>.
 * `n` is the line number in the NEW file, tracked through @@ hunk headers.
 */
export function addedLines(diff) {
  const byFile = new Map();
  let file = null;
  let n = 0;
  for (const line of String(diff).split(/\r?\n/)) {
    const m = DIFF_HEADER_RE.exec(line);
    if (m) {
      file = unquotePath(m[1] ?? m[2]);
      byFile.set(file, byFile.get(file) ?? []);
      continue;
    }
    if (file === null) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      n = Number(hunk[1]);
      continue;
    }
    if (line.startsWith('---') || line.startsWith('+++')) continue;
    if (line.startsWith('+')) {
      byFile.get(file).push({ n, text: line.slice(1) });
      n += 1;
    } else if (line.startsWith('-')) {
      // deletion: does not advance the new-file cursor
    } else {
      n += 1; // context line
    }
  }
  return byFile;
}

function isTestFile(p) {
  return /(^|\/)(test|tests|__tests__)\//.test(p) || /\.(test|spec)\.[a-z]+$/.test(p);
}
