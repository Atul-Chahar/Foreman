// The Spec Enhancer. The quality of a swarm's output is capped by the
// quality of the specs it receives: a raw one-line issue sprayed across 8
// parallel agents produces 8 different kinds of garbage.
//
// Before anything is dispatched, each issue becomes a structured task spec:
// scope (context_files, touches), verifiable acceptance criteria, the exact
// test command, a risk tier, and cross-task conflict detection.
//
// If an LLM endpoint is configured (FOREMAN_TRUEFORGE_*), the planner role
// refines specs with it (see skills/planner). The heuristic parser below is
// the deterministic baseline: always runs, zero credentials, testable.

import { slug } from '../core/ids.mjs';

const FILE_RE = /\b((?:src|lib|test|tests|app|harness|scripts)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+)/g;
const CMD_RE = /^\s*(?:test|run tests|command)\s*:\s*`?([^`\n]+)`?/im;
const CRITERIA_RE = /^\s*(?:acceptance|criteria|done when)\s*:\s*$/im;

/** Extract a structured spec from a raw issue. Pure; safe to re-run. */
export function enhanceSpec(issue, { taskId }) {
  const body = String(issue.body ?? '');

  const contextFiles = [...new Set(matchAll(body, FILE_RE))];

  let testCommand = null;
  const cmdMatch = CMD_RE.exec(body);
  if (cmdMatch) testCommand = cmdMatch[1].trim();

  // Acceptance criteria: bullets under an 'acceptance:' heading, or all
  // checkbox/bullet lines when no heading exists.
  const lines = body.split(/\r?\n/);
  const criteria = [];
  let inCriteria = false;
  for (const line of lines) {
    if (CRITERIA_RE.test(line)) { inCriteria = true; continue; }
    if (inCriteria || lines.some((l) => CRITERIA_RE.test(l))) {
      const m = /^\s*(?:[-*]|\[\s?[xX]?\])\s+(.{3,})$/.exec(line);
      if (m) criteria.push(m[1].trim());
      else if (inCriteria && line.trim() === '') inCriteria = false;
    }
  }
  if (criteria.length === 0) {
    for (const line of lines) {
      const m = /^\s*(?:[-*]|#{1,4}\s|\d+\.)\s+(.{3,})$/.exec(line);
      if (m) criteria.push(m[1].trim());
    }
  }

  // risk tier: anything mentioning main, deletion, or migration escalates
  const risky = /merge to main|force.?push|delete|drop|destructive/i.test(body);
  const riskTier = risky ? 'T2' : 'T1';

  // files this task is expected to modify = context files under src/ or lib/
  const touches = contextFiles.filter((f) => /^(src|lib)\//.test(f));

  return {
    id: taskId,
    title: issue.title,
    issue_number: issue.number,
    source: 'github-issue',
    context_files: contextFiles,
    acceptance_criteria: [...new Set(criteria)].slice(0, 8),
    test_command: testCommand,
    touches,
    risk_tier: riskTier,
    conflicts_with: [],
    body_excerpt: body.slice(0, 600),
  };
}

/** Planner pass over a whole backlog: enhance + compute the conflict graph. */
export class Planner {
  /**
   * @param {object} deps
   * @param {import('../core/events.mjs').EventBus} deps.bus
   * @param {(e: object) => void} deps.persist
   */
  constructor({ bus, persist }) {
    this.bus = bus;
    this.persist = persist;
  }

  /**
   * @param {Array<{number:number,title:string,body:string,labels?:string[]}>} issues
   * @returns specs with conflicts_with populated. Two tasks conflict when
   *          their `touches` sets overlap — the scheduler will never run
   *          conflicting tasks concurrently.
   */
  plan(issues) {
    const specs = issues.map((issue, i) => {
      const taskId = `task-${String(issue.number ?? i + 1).padStart(3, '0')}`;
      return enhanceSpec(issue, { taskId });
    });

    for (let i = 0; i < specs.length; i++) {
      for (let j = i + 1; j < specs.length; j++) {
        const overlap = specs[i].touches.filter((f) => specs[j].touches.includes(f));
        if (overlap.length > 0) {
          specs[i].conflicts_with.push(specs[j].id);
          specs[j].conflicts_with.push(specs[i].id);
        }
      }
    }

    for (const s of specs) {
      this.bus.emitEvent('planner.spec_ready', {
        taskId: s.id, title: s.title, touches: s.touches,
        conflicts_with: s.conflicts_with, risk_tier: s.risk_tier,
      }, this.persist);
    }
    return specs;
  }
}

function matchAll(text, re) {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

export { slug };
