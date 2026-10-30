import { randomUUID } from 'node:crypto';
import { withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { resolveBuildingsForUser } from '../building-assignments';
import { buildingAccessDeniedError } from '../context-access';
import { permissionRepository } from '../permissions';
import { handymanDocumentSettingsRepository } from './handyman-document-settings.repository';
import type { HandymanDocumentSettingsLanguage } from './handyman-document-settings.types';

export const PAYMENT_RECEIPT_POLICY_CODE = 'HM_PR_ISSUER_YEAR_V1';
export const PAYMENT_RECEIPT_NUMBER_FORMAT = 'HM-PR-{YYYY}-{SEQ:06}';
export const PAYMENT_RECEIPT_NUMBER_SCOPE = 'ISSUER_CLIENT_CALENDAR_YEAR';
export const PAYMENT_RECEIPT_TIME_ZONE = 'Asia/Jakarta';

type ApprovalRow = { id: string; client_id: string; settings_id: string; settings_version: number;
  policy_code: string; approved_by_user_id: string; approved_at: Date; status: string };

/** A separate, explicit manager decision. The ACTIVE settings row on its own is
 * never approval; replacing that exact version stops issuance until reapproval. */
export async function activatePaymentReceiptNumbering(input: {
  clientId: string; language: HandymanDocumentSettingsLanguage; settingsId: unknown; settingsVersion: unknown;
  policyCode: unknown; approve: unknown; actorUserId: string; sessionId: string;
}) {
  if (!isValidUuid(input.clientId) || !isValidUuid(input.actorUserId) || !isValidUuid(input.sessionId) ||
      typeof input.settingsId !== 'string' || !isValidUuid(input.settingsId) ||
      typeof input.settingsVersion !== 'number' || !Number.isSafeInteger(input.settingsVersion) ||
      input.settingsVersion < 1 || input.settingsVersion > 2147483647 ||
      !['id', 'en'].includes(input.language) || input.policyCode !== PAYMENT_RECEIPT_POLICY_CODE || input.approve !== true) {
    throw AppError.validation('Explicit approval of the exact PAYMENT_RECEIPT settings version and policy is required.');
  }
  const settingsId = input.settingsId;
  const settingsVersion = input.settingsVersion;
  return withTransaction(async tx => {
    // Same provider-wide writer lock and scope as document settings; recheck the
    // live session, explicit permission and Client access inside the transaction.
    const client = (await tx.query<{ status: string }>('SELECT status FROM clients WHERE id=$1 FOR UPDATE', [input.clientId])).rows[0];
    if (!client || client.status !== 'ACTIVE') throw AppError.notFound('Client not found.');
    const session = await tx.query(`SELECT u.id FROM users u JOIN user_sessions s ON s.user_id=u.id
      WHERE u.id=$1 AND u.status='ACTIVE' AND s.id=$2 AND s.status='ACTIVE' AND s.expires_at>clock_timestamp()
      FOR SHARE OF u,s`, [input.actorUserId, input.sessionId]);
    const permissions = await permissionRepository.listActivePermissionCodesForUser(input.actorUserId, tx);
    if (!session.rowCount || !permissions.includes('handyman.commercial.manage')) {
      throw new AppError({ code: ERROR_CODES.PERMISSION_DENIED, statusCode: 403,
        message: 'An active session with handyman.commercial.manage is required.' });
    }
    const contexts = await resolveBuildingsForUser(input.actorUserId, tx);
    if (!contexts.some(c => c.client?.id === input.clientId)) throw buildingAccessDeniedError();

    // Lock approval before settings, the same order as receipt issuance.
    const current = (await tx.query<ApprovalRow>(`SELECT * FROM handyman_payment_receipt_numbering_approvals
      WHERE client_id=$1 AND status='ACTIVE' FOR UPDATE`, [input.clientId])).rows[0];
    const settings = await handymanDocumentSettingsRepository.lockActive(tx, input.clientId, 'PAYMENT_RECEIPT', input.language);
    if (!settings || settings.id !== settingsId.toLowerCase() || settings.version !== settingsVersion || settings.documentPrefix !== 'HM-PR') {
      throw new AppError({ code: ERROR_CODES.HANDYMAN_TENANT_RECEIPT_CONFLICT, statusCode: 409,
        message: 'The exact PAYMENT_RECEIPT settings version is not active; refresh before approval.' });
    }
    let row: ApprovalRow, replayed = false;
    if (current?.settings_id === settings.id && current.settings_version === settings.version) {
      row = current; replayed = true;
    } else {
      if (current) await tx.query(`UPDATE handyman_payment_receipt_numbering_approvals
        SET status='SUPERSEDED',superseded_at=clock_timestamp() WHERE id=$1`, [current.id]);
      row = (await tx.query<ApprovalRow>(`INSERT INTO handyman_payment_receipt_numbering_approvals
        (id,client_id,settings_id,settings_version,policy_code,approved_by_user_id,approved_session_id,status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'ACTIVE') RETURNING *`,
      [randomUUID(), input.clientId, settings.id, settings.version, PAYMENT_RECEIPT_POLICY_CODE, input.actorUserId, input.sessionId])).rows[0]!;
    }
    return { id: row.id, clientId: row.client_id, settingsId: row.settings_id, settingsVersion: row.settings_version,
      language: settings.language, status: row.status, policyCode: row.policy_code, format: PAYMENT_RECEIPT_NUMBER_FORMAT,
      timeZone: PAYMENT_RECEIPT_TIME_ZONE, scope: PAYMENT_RECEIPT_NUMBER_SCOPE, approvedByUserId: row.approved_by_user_id,
      approvedAt: row.approved_at.toISOString(), replayed };
  });
}
