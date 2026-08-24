// Risk tiers. Every action the swarm can request is classified into exactly
// one tier, and the tier decides who is allowed to say yes.
//
//   T0  read-only            auto-approved, always
//   T1  reversible writes    auto-approved only when the human opts in
//   T2  irreversible         human approval, ALWAYS — see T2_AUTO_APPROVABLE
//
// ─────────────────────────────────────────────────────────────────────────────
// THERE IS NO CONFIGURATION, ENVIRONMENT VARIABLE, FEATURE FLAG, OR CODE PATH
// THAT CAN AUTO-APPROVE T2. The constant below is the guarantee. A reviewer
// who greps for a bypass will find this refusal instead.
// ─────────────────────────────────────────────────────────────────────────────

export const TIERS = Object.freeze({
  T0: 'T0',
  T1: 'T1',
  T2: 'T2',
});

/** THE invariant of the entire system. Do not change. Do not parameterize. */
export const T2_AUTO_APPROVABLE = false;

export const TIER_DESCRIPTIONS = Object.freeze({
  T0: 'read-only — reading issues, files, CI status',
  T1: 'reversible writes — branches, pushes, PRs, comments',
  T2: 'irreversible — merge to main, force-push, delete, close',
});

/** Action registry. An unclassified action is refused (fail closed). */
const ACTIONS = Object.freeze({
  // T0 — read-only
  read_issue: TIERS.T0,
  read_file: TIERS.T0,
  list_issues: TIERS.T0,
  get_ci_status: TIERS.T0,
  get_pr_diff: TIERS.T0,
  get_pr_review: TIERS.T0,

  // T1 — reversible writes
  create_branch: TIERS.T1,
  push_branch: TIERS.T1,
  open_pr: TIERS.T1,
  comment: TIERS.T1,
  update_file: TIERS.T1,

  // T2 — irreversible
  merge_to_main: TIERS.T2,
  force_push: TIERS.T2,
  delete_branch: TIERS.T2,
  close_issue: TIERS.T2,
});

export function classify(action) {
  return ACTIONS[action] ?? null;
}

export const AUTO_APPROVABLE_TIERS = Object.freeze(
  new Set([TIERS.T0]), // T1 joins only when policy.t1Auto is enabled by a human
);
