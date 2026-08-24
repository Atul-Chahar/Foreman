// Task and entity id helpers. Ids are stable and idempotency keys:
// a task id maps 1:1 to a branch name and at most one PR.

const ALPHANUM = /^[a-z0-9][a-z0-9-]*$/;

/** A task id like "task-007" becomes branch "foreman/task-007". */
export function branchForTask(taskId) {
  return `foreman/${taskId}`;
}

/** Inverse of branchForTask; null when the branch is not a task branch. */
export function taskForBranch(branch) {
  const m = /^foreman\/(task-[a-z0-9-]+)$/.exec(branch ?? '');
  return m ? m[1] : null;
}

/** Slugify an issue title into a task id suffix. */
export function slug(title, maxLen = 24) {
  const s = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/, '');
  return ALPHANUM.test(s) ? s : 'task';
}

export function newRunId(now = new Date()) {
  return `run-${now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
}

export function newApprovalId(seq) {
  return `appr-${String(seq).padStart(4, '0')}`;
}
