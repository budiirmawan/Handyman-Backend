import type { PoolClient } from 'pg';
import { AppError, ERROR_CODES } from '../../shared/errors';

/** Called after normal actor/replay checks, inside the approval transaction.
 * The database triggers independently enforce this for all writer paths. */
export async function assertRequestOpenForOriginalApproval(tx: PoolClient, requestId: string) {
  try {
    await tx.query('SELECT hm_request_require_original_open(ARRAY[$1::uuid])', [requestId]);
  } catch (error) {
    if ((error as { constraint?: string }).constraint === 'hm_request_closed_guard') {
      throw new AppError({ code: ERROR_CODES.HANDYMAN_REQUEST_ALREADY_CLOSED, statusCode: 409,
        message: 'Main Request is CLOSED; new original commercial approval requires a separate authorized lifecycle.' });
    }
    throw error;
  }
}

/** Warranty rework is a separate scope and is intentionally not fenced. */
export async function assertOriginalScopeOpenForApproval(tx: PoolClient, scopeId: string) {
  const scope = (await tx.query<{handyman_request_id:string;scope_kind:string}>(
    'SELECT handyman_request_id,scope_kind FROM handyman_execution_scopes WHERE id=$1', [scopeId])).rows[0];
  if (!scope) throw AppError.notFound('Execution scope not found.');
  if (scope.scope_kind === 'ORIGINAL') await assertRequestOpenForOriginalApproval(tx,scope.handyman_request_id);
}
