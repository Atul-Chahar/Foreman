// The explicit task state machine. No implicit states exist anywhere in the
// harness: every transition must appear in TRANSITIONS or the store refuses it.

export const STATES = Object.freeze({
  PLANNED: 'planned',
  DISPATCHED: 'dispatched',
  RUNNING: 'running',
  TESTS_PASSED: 'tests_passed',
  TESTS_FAILED: 'tests_failed',
  PR_OPEN: 'pr_open',
  AWAITING_APPROVAL: 'awaiting_approval',
  MERGED: 'merged',
  REJECTED: 'rejected',
  NEEDS_HUMAN: 'needs_human',
  FAILED: 'failed',
});

const T = STATES;

/** Allowed transitions. Anything not listed is a bug, not a shortcut. */
export const TRANSITIONS = Object.freeze({
  [T.PLANNED]: [T.DISPATCHED, T.NEEDS_HUMAN, T.FAILED, T.REJECTED],
  [T.DISPATCHED]: [T.RUNNING, T.FAILED, T.NEEDS_HUMAN],
  [T.RUNNING]: [T.TESTS_PASSED, T.TESTS_FAILED, T.FAILED, T.NEEDS_HUMAN],
  [T.TESTS_PASSED]: [T.PR_OPEN, T.FAILED, T.NEEDS_HUMAN, T.REJECTED],
  [T.TESTS_FAILED]: [T.DISPATCHED, T.FAILED, T.NEEDS_HUMAN, T.REJECTED], // retry loop, or human drops it
  [T.PR_OPEN]: [T.AWAITING_APPROVAL, T.NEEDS_HUMAN, T.REJECTED],
  [T.AWAITING_APPROVAL]: [T.MERGED, T.REJECTED, T.NEEDS_HUMAN],
  [T.NEEDS_HUMAN]: [T.PLANNED, T.DISPATCHED, T.REJECTED], // human resolves
  [T.MERGED]: [],
  [T.REJECTED]: [],
  [T.FAILED]: [T.DISPATCHED, T.PLANNED, T.REJECTED, T.NEEDS_HUMAN], // bounded retry, escalation, or human drops it
});

export const TERMINAL_STATES = Object.freeze(
  new Set([T.MERGED, T.REJECTED]),
);

export function canTransition(from, to) {
  const allowed = TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

export class InvalidTransition extends Error {
  constructor(from, to) {
    super(`illegal task state transition ${from} -> ${to}`);
    this.name = 'InvalidTransition';
    this.from = from;
    this.to = to;
  }
}

/** Throw unless the transition is legal. */
export function assertTransition(from, to) {
  if (!canTransition(from, to)) throw new InvalidTransition(from, to);
}
