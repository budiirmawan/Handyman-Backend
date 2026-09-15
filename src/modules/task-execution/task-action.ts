/**
 * BE-25C — Task execution action authority.
 *
 * Backend-authoritative available actions for a generated Task, derived from
 * the same transition rules the execution endpoints enforce. Single source of
 * truth: the execution routes and the mobile assignment feed both resolve
 * actions here, so clients never infer workflow authority.
 *
 * Assignee eligibility is contextual (the feed only lists the caller's own
 * assignments; the execution routes enforce the WORKFORCE assignee check
 * separately).
 */

export const TASK_ACTIONS = ['START', 'COMPLETE', 'CANCEL'] as const;

export type TaskAction = (typeof TASK_ACTIONS)[number];

export function resolveTaskAvailableActions(status: string): TaskAction[] {
  const actions: TaskAction[] = [];
  if (status === 'OPEN' || status === 'ASSIGNED') {
    actions.push('START');
  }
  if (status === 'IN_PROGRESS') {
    actions.push('COMPLETE');
  }
  if (status === 'OPEN' || status === 'ASSIGNED' || status === 'IN_PROGRESS') {
    actions.push('CANCEL');
  }
  return actions;
}
