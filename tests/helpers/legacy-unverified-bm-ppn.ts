// TEST-ONLY legacy projection. It is explicitly unverified and is not exported by production modules.
import { getPool } from '../../src/database';
import { isValidUuid } from '../../src/modules/clients';
import { requireApprovedIdentityAtInSnapshot } from '../../src/modules/handyman-tax-identity/handyman-tax-identity.service';
import { resolveHandymanTaxRuleInSnapshot } from '../../src/modules/handyman-tax-rules/handyman-tax-rules.service';
import { calculatePpnFromResolved, normalizePpnInput, ppnError } from '../../src/modules/handyman-ppn-calculation/handyman-ppn-core';
import type { ApprovedPpnBreakdown, CalculateApprovedPpnInput } from '../../src/modules/handyman-ppn-calculation';

/**
 * Test-only unverified projection: all three approvals are resolved in one database
 * snapshot and matched against caller-supplied immutable pins. The math is pure;
 * this method does not post, persist, issue or link a financial transaction.
 */
export function calculateUnverifiedPpn(actorInput: string, input: CalculateApprovedPpnInput): Promise<ApprovedPpnBreakdown>;
export async function calculateUnverifiedPpn(actorInput: string, input: CalculateApprovedPpnInput): Promise<ApprovedPpnBreakdown> {
  if (typeof actorInput !== 'string' || !isValidUuid(actorInput))
    throw ppnError('HANDYMAN_PPN_INVALID','An authenticated actor is required.',400);
  const actor = actorInput.toLowerCase();
  const n = normalizePpnInput(input as CalculateApprovedPpnInput), tx = await getPool().connect();
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const row = (await tx.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS read_at")).rows[0];
    const readAt = (row.read_at as Date).toISOString();
    const cutoff = new Date(Math.min(new Date(readAt).getTime(),new Date(n.taxPointAt).getTime())).toISOString();
    const supplier = await requireApprovedIdentityAtInSnapshot(tx,actor,n.supplier.owner,n.taxPointAt);
    const recipient = await requireApprovedIdentityAtInSnapshot(tx,actor,n.recipient.owner,n.taxPointAt);
    const rule = await resolveHandymanTaxRuleInSnapshot(tx,actor,{ clientId:n.clientId, transactionContext:n.transactionContext,
      taxCode:'PPN', taxpayerClassification:n.taxpayerClassification, taxDate:n.taxDate, knownAt:cutoff });
    if (rule.status === 'MISSING') throw ppnError('HANDYMAN_PPN_MISSING_RULE','No exact PPN rule exists for the requested tax date.');
    if (rule.status === 'AMBIGUOUS') throw ppnError('HANDYMAN_PPN_AMBIGUOUS_RULE','More than one PPN rule matches the exact scope.');
    if (rule.status === 'NOT_APPROVED') throw ppnError('HANDYMAN_PPN_NOT_APPROVED','The exact PPN rule was not approved by the required instant.');
    if (rule.status === 'INTEGRITY_ERROR') throw ppnError('HANDYMAN_PPN_INTEGRITY_ERROR','The PPN rule failed its integrity checks.');
    if (rule.status !== 'APPROVED') throw ppnError('HANDYMAN_PPN_NOT_APPROVED','The PPN rule is not approved.');
    const result = calculatePpnFromResolved(n,supplier,recipient,rule,readAt);
    await tx.query('COMMIT');
    return result;
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally { tx.release(); }
}
