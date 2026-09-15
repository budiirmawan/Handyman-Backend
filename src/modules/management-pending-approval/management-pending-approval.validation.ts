import { parseManagementReadScopeQuery } from '../management-read-scope';
import type { ManagementPendingApprovalQuery } from './management-pending-approval.types';

/** PART 03A adds no workflow filter; PART 01 owns scope and period validation. */
export function parseManagementPendingApprovalQuery(
  query: Record<string, unknown>,
): ManagementPendingApprovalQuery {
  return { scope: parseManagementReadScopeQuery(query) };
}
