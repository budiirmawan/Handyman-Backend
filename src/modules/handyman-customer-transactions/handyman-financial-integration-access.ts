import type { PoolClient } from 'pg';
import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { canAccessBuildingScopedResource } from '../context-access';
import { permissionService } from '../permissions';
export type FinancialExecutor = Pick<PoolClient, 'query'>;
export function financialId(v: unknown): string {
  if (typeof v !== 'string' || !isValidUuid(v))
    throw AppError.validation('A valid resource UUID is required.');
  return v;
}
export async function financialPermission(actor: string, code = 'handyman.finance.manage') {
  if (!(await permissionService.resolvePermissionsForUser(financialId(actor))).includes(code))
    throw new AppError({
      code: 'PERMISSION_DENIED',
      statusCode: 403,
      message: `Explicit ${code} authority is required; a role name is not authority.`,
    });
}
export async function financialRequest(
  tx: FinancialExecutor,
  requestId: string,
  actor: string,
  lock = false,
) {
  const r = (
    await tx.query(
      `SELECT * FROM handyman_service_requests WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`,
      [financialId(requestId)],
    )
  ).rows[0];
  if (!r) throw AppError.notFound();
  if (
    !r.building_id ||
    !(await canAccessBuildingScopedResource(actor, {
      clientId: r.client_id,
      buildingId: r.building_id,
    }))
  )
    throw new AppError({
      code: 'BUILDING_ACCESS_DENIED',
      statusCode: 403,
      message: 'Exact request Building authority is required.',
    });
  return r;
}
export async function financialScope(
  tx: FinancialExecutor,
  scopeId: string,
  actor: string,
  lock = false,
) {
  const scope = (
    await tx.query(
      `SELECT * FROM handyman_execution_scopes WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`,
      [financialId(scopeId)],
    )
  ).rows[0];
  if (!scope) throw AppError.notFound();
  if (
    !(await canAccessBuildingScopedResource(actor, {
      clientId: scope.client_id,
      buildingId: scope.building_id,
    }))
  )
    throw new AppError({
      code: 'BUILDING_ACCESS_DENIED',
      statusCode: 403,
      message: 'Exact execution-scope Building authority is required.',
    });
  return scope;
}
export async function financialQuotation(tx: FinancialExecutor, version: string, actor: string) {
  const row = (
    await tx.query(
      `SELECT v.*,q.handyman_request_id FROM handyman_quotation_versions v
    JOIN handyman_quotations q ON q.id=v.quotation_id WHERE v.id=$1 FOR SHARE OF v`,
      [financialId(version)],
    )
  ).rows[0];
  if (!row) throw AppError.notFound();
  const request = await financialRequest(tx, row.handyman_request_id, actor);
  return { version: row, request };
}
