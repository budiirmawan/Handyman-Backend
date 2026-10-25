import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PoolClient } from 'pg';
import { readHandymanLedgerTransactionAt } from '../handyman-customer-ledger-read';
import { getPool, withTransaction } from '../../database';
import { AppError } from '../../shared/errors';
import { hasVerifiedHandymanBastCustomerAcceptance } from '../handyman-bast';
import { assertCurrentGuardedHandymanQcPass } from '../handyman-evidence-qc/handyman-qc-pass-gate';
import { canAccessClient } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { adjustHandymanCustomerLedger } from '../handyman-customer-ledger-corrections';
import {
  calculateHandymanIndonesiaTax,
  financialConfig,
  financialConflict,
  financialDecimal as decimal,
  financialMoney as money,
  financialReference as reference,
  jakartaDate,
  validateHandymanTaxFacts,
  type HandymanTaxAmounts,
} from '../handyman-pricing-contract/handyman-indonesia-tax';
import {
  financialId,
  financialPermission,
  financialQuotation,
  financialScope,
  type FinancialExecutor,
} from './handyman-financial-integration-access';

export async function prepareHandymanTaxProfile(
  target: { quotationVersionId?: string; agreementVersionId?: string },
  facts: unknown,
  actor: string,
) {
  if (Boolean(target.quotationVersionId) === Boolean(target.agreementVersionId))
    throw AppError.validation('Exactly one quotation/agreement version is required.');
  await financialPermission(
    actor,
    target.agreementVersionId ? 'handyman.commercial.manage' : 'handyman.finance.manage',
  );
  const reviewed = validateHandymanTaxFacts(facts);
  return withTransaction(async (tx) => {
    let clientId: string, buildingId: string | undefined, status: string;
    if (target.quotationVersionId) {
      const ctx = await financialQuotation(tx, target.quotationVersionId, actor);
      clientId = ctx.request.client_id;
      buildingId = ctx.request.building_id;
      status = ctx.version.status;
    } else {
      const a = (
        await tx.query(
          `SELECT v.status,a.client_id FROM handyman_commercial_agreement_versions v JOIN handyman_commercial_agreements a ON a.id=v.agreement_id WHERE v.id=$1 FOR SHARE OF v`,
          [financialId(target.agreementVersionId)],
        )
      ).rows[0];
      if (!a) throw AppError.notFound();
      if (!(await canAccessClient(actor, a.client_id)))
        throw new AppError({
          code: 'BUILDING_ACCESS_DENIED',
          statusCode: 403,
          message: 'Agreement Client access required.',
        });
      clientId = a.client_id;
      status = a.status;
      if (!reviewed.bmSettlementTiming)
        financialConfig('An explicit supported BM contract settlement timing is required.');
    }
    const prev = (
      await tx.query(
        `SELECT * FROM handyman_financial_tax_profiles WHERE quotation_version_id=$1 OR agreement_version_id=$2`,
        [target.quotationVersionId ?? null, target.agreementVersionId ?? null],
      )
    ).rows[0];
    if (prev) {
      if (!isDeepStrictEqual(prev.facts, reviewed))
        financialConflict(
          'Tax facts are immutable; use a newly reviewed quotation/agreement version, never rewrite an issued tax document.',
        );
      return prev;
    }
    if (status !== 'DRAFT')
      financialConflict(
        'Reviewed price/tax treatment must be bound before issuing/activating the exact commercial version.',
      );
    const row = (
      await tx.query(
        `INSERT INTO handyman_financial_tax_profiles(id,quotation_version_id,agreement_version_id,facts,created_by_user_id)
      VALUES($1,$2,$3,$4,$5) RETURNING *`,
        [
          randomUUID(),
          target.quotationVersionId ?? null,
          target.agreementVersionId ?? null,
          JSON.stringify(reviewed),
          actor,
        ],
      )
    ).rows[0];
    await recordOperationalEvent(
      {
        clientId,
        buildingId,
        actorUserId: actor,
        eventType: 'HANDYMAN_TAX_FACTS_REVIEWED',
        entityType: 'HANDYMAN_FINANCIAL_TAX_PROFILE',
        entityId: row.id,
        summary: 'Effective-dated tax facts bound to an exact draft commercial version.',
        metadata: {
          quotationVersionId: target.quotationVersionId ?? null,
          agreementVersionId: target.agreementVersionId ?? null,
          sourceReference: reviewed.sourceReference,
        },
      },
      tx,
    );
    return row;
  });
}
/** An explicit Manager verification reference over the existing CONFIRMED
 * payment; no callback, proof image or Care statement can create this fact.
 * received_at remains the immutable original reporting timestamp. */
export async function reconcileHandymanPayment(
  scopeId: string,
  paymentId: string,
  input: { bankReference: string; actualReceivedAt: string; idempotencyKey: string },
  actor: string,
) {
  await financialPermission(actor);
  const bank = reference(input.bankReference),
    key = reference(input.idempotencyKey),
    date = new Date(input.actualReceivedAt);
  if (!Number.isFinite(date.getTime()) || date.getTime() > Date.now())
    throw AppError.validation('Actual received time must be a valid, nonfuture bank/payment fact.');
  return withTransaction(async (tx) => {
    const scope = await financialScope(tx, scopeId, actor, true);
    const anchor = (
      await tx.query(
        `SELECT p.* FROM handyman_customer_payments p JOIN handyman_customer_transactions t ON t.id=p.transaction_id WHERE p.id=$1 AND t.execution_scope_id=$2 FOR UPDATE OF p,t`,
        [financialId(paymentId), scope.id],
      )
    ).rows[0];
    if (!anchor) throw AppError.notFound();
    const prev = (
      await tx.query('SELECT * FROM handyman_payment_reconciliations WHERE payment_id=$1', [
        paymentId,
      ])
    ).rows[0];
    if (prev) {
      if (
        prev.bank_reference !== bank ||
        prev.actual_received_at.toISOString() !== date.toISOString() ||
        prev.idempotency_key !== key ||
        prev.verified_by_user_id !== actor
      )
        financialConflict(
          'The verified payment reference/time cannot be rewritten or replayed by another actor.',
        );
      return { ...prev, replayed: true };
    }
    if (anchor.status !== 'CONFIRMED')
      financialConflict('Only an existing Finance-confirmed payment can be bank-reconciled.');
    if (!anchor.decided_at || date.getTime() > anchor.decided_at.getTime())
      financialConflict(
        'Actual receipt cannot occur after the Manager already confirmed those funds.',
      );
    const duplicate = (
      await tx.query(
        'SELECT id FROM handyman_payment_reconciliations WHERE client_id=$1 AND bank_reference=$2',
        [scope.client_id, bank],
      )
    ).rows[0];
    if (duplicate)
      financialConflict('This actual bank receipt was already used for another payment.');
    let row;
    try {
      row = (
        await tx.query(
          `INSERT INTO handyman_payment_reconciliations(id,payment_id,client_id,bank_reference,actual_received_at,verified_by_user_id,idempotency_key)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [randomUUID(), paymentId, scope.client_id, bank, date, actor, key],
        )
      ).rows[0];
    } catch (e) {
      if ((e as { code?: string }).code === '23505')
        financialConflict('Duplicate bank receipt/payment reconciliation.');
      throw e;
    }
    await recordOperationalEvent(
      {
        clientId: scope.client_id,
        buildingId: scope.building_id,
        actorUserId: actor,
        eventType: 'HANDYMAN_PAYMENT_BANK_RECONCILED',
        entityType: 'HANDYMAN_CUSTOMER_PAYMENT',
        entityId: paymentId,
        summary: 'Manager/Finance recorded actual receipt time and reconciliation reference.',
        metadata: { reconciliationId: row.id, actualReceivedAt: date.toISOString() },
      },
      tx,
    );
    return { ...row, replayed: false };
  });
}
export async function readHandymanScopeTaxBasis(
  db: FinancialExecutor,
  scope: Record<string, any>,
  commercialOnly = false,
  asOf = jakartaDate(new Date()),
) {
  if (
    (
      await db.query(
        `SELECT c.id FROM handyman_ledger_corrections c JOIN handyman_customer_transactions t ON t.id=c.transaction_id
    WHERE t.execution_scope_id=$1 AND c.correction_kind='ADJUSTMENT' AND c.source_charge_line_id IS NULL LIMIT 1`,
        [scope.id],
      )
    ).rowCount
  )
    financialConfig(
      'A transaction-level adjustment cannot be silently attributed across tax classifications or labor/material.',
    );
  const currencies = (
    await db.query(
      'SELECT DISTINCT currency FROM handyman_quotation_lines WHERE quotation_version_id=$1',
      [scope.approved_quotation_version_id],
    )
  ).rows;
  if (currencies.length !== 1 || currencies[0].currency !== 'IDR')
    financialConfig(
      'Indonesian fiscal posting requires an actual IDR tax basis; governed tax FX is not inferred.',
    );
  const variations = (
    await db.query(
      `SELECT revised_quotation_version_id FROM handyman_scope_variations WHERE execution_scope_id=$1 AND tenant_decision_outcome='APPROVED'
    AND status IN ('AUTHORIZED_SCOPE','EXECUTION','QC','FINAL_CHARGE_ELIGIBILITY')`,
      [scope.id],
    )
  ).rows;
  const profile = (
    await db.query('SELECT * FROM handyman_financial_tax_profiles WHERE quotation_version_id=$1', [
      scope.approved_quotation_version_id,
    ])
  ).rows[0];
  if (!profile)
    financialConfig(
      'Provider PKP/non-PKP, service/payer/withholding and agreed inclusive-price facts are missing for this approved quotation.',
    );
  const f = validateHandymanTaxFacts(profile.facts);
  for (const v of variations) {
    const reviewed = (
      await db.query(
        'SELECT facts FROM handyman_financial_tax_profiles WHERE quotation_version_id=$1',
        [v.revised_quotation_version_id],
      )
    ).rows[0];
    if (!reviewed)
      financialConfig('Every authorized revised quotation needs its own reviewed tax facts.');
    const revised = validateHandymanTaxFacts(reviewed.facts);
    const policy = (facts: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(facts).filter(
          ([k]) => !['sourceReference', 'classificationReference'].includes(k),
        ),
      );
    if (!isDeepStrictEqual(policy(revised), policy(f)))
      financialConfig('Mixed tax classifications cannot be guessed.');
    calculateHandymanIndonesiaTax(revised, '0.00', '0.00', asOf);
  }
  const lines = (
    await db.query(
      `SELECT l.line_kind,(l.amount-COALESCE((SELECT SUM(c.amount) FROM handyman_ledger_corrections c
      WHERE c.source_charge_line_id=l.id AND c.correction_kind='ADJUSTMENT' AND NOT EXISTS(
        SELECT 1 FROM handyman_fiscal_withholding_credits wc WHERE wc.correction_id=c.id)),0))::numeric(18,2)::text gross
    FROM handyman_charge_lines l JOIN handyman_customer_transactions t ON t.id=l.transaction_id WHERE t.execution_scope_id=$1`,
      [scope.id],
    )
  ).rows;
  let labor = 0n,
    material = 0n;
  if (lines.length && !commercialOnly)
    for (const l of lines) {
      if (l.line_kind === 'LABOR') labor += money(l.gross);
      else material += money(l.gross);
    }
  else {
    const quoted = (
      await db.query(
        `SELECT line_type,SUM(line_total)::numeric(18,2)::text gross FROM handyman_quotation_lines WHERE quotation_version_id=$1 GROUP BY line_type`,
        [scope.approved_quotation_version_id],
      )
    ).rows;
    for (const l of quoted) {
      if (l.line_type === 'LABOR') labor += money(l.gross);
      else material += money(l.gross);
    }
    const deltas = (
      await db.query(
        `SELECT line_type,COALESCE(SUM(quoted_total_delta),0)::numeric(18,2)::text delta FROM handyman_scope_variations
      WHERE execution_scope_id=$1 AND tenant_decision_outcome='APPROVED' AND status IN ('AUTHORIZED_SCOPE','EXECUTION','QC','FINAL_CHARGE_ELIGIBILITY') GROUP BY line_type`,
        [scope.id],
      )
    ).rows;
    for (const d of deltas) {
      const n = BigInt(String(d.delta).replace('.', ''));
      if (d.line_type === 'LABOR') labor += n;
      else material += n;
    }
    // A pre-delivery advance follows the agreed commercial scope even when
    // only SOME ledger lines have been composed. Restore no withholding as
    // revenue and subtract only the explicitly agreed inspection discount.
    const discounts = (
      await db.query(
        `SELECT l.line_kind,c.amount FROM handyman_inspection_fee_credits cr JOIN handyman_ledger_corrections c ON c.id=cr.correction_id
      JOIN handyman_charge_lines l ON l.id=c.source_charge_line_id WHERE cr.job_execution_scope_id=$1`,
        [scope.id],
      )
    ).rows;
    for (const d of discounts) {
      if (d.line_kind === 'LABOR') labor -= money(String(d.amount));
      else material -= money(String(d.amount));
    }
    if (
      commercialOnly &&
      (
        await db.query(
          `SELECT c.id FROM handyman_ledger_corrections c JOIN handyman_customer_transactions t ON t.id=c.transaction_id
      WHERE t.execution_scope_id=$1 AND c.correction_kind='ADJUSTMENT' AND NOT EXISTS(SELECT 1 FROM handyman_inspection_fee_credits cr WHERE cr.correction_id=c.id)
      AND NOT EXISTS(SELECT 1 FROM handyman_fiscal_withholding_credits wc WHERE wc.correction_id=c.id) LIMIT 1`,
          [scope.id],
        )
      ).rowCount
    )
      financialConfig(
        'A manual pre-delivery price correction needs reviewed scope reconciliation; it cannot silently change an advance tax basis.',
      );
  }
  if (labor < 0n || material < 0n) financialConflict('Net commercial scope cannot be negative.');
  return {
    profile,
    facts: f,
    grossLabor: decimal(labor),
    grossMaterial: decimal(material),
    basisSource:
      lines.length && !commercialOnly
        ? 'POSTED_CORRECTION_NETTED_LEDGER'
        : 'APPROVED_COMMERCIAL_SCOPE',
  };
}
const amountKeys: (keyof HandymanTaxAmounts)[] = [
  'grossLabor',
  'grossMaterial',
  'gross',
  'serviceNet',
  'dpp',
  'vat',
  'incomeTaxBase',
  'incomeTaxDue',
  'withholding',
  'selfRemittance',
  'cashDue',
];
const signed = (s: string) => BigInt(s.replace('.', ''));
function subtractAmounts(
  total: HandymanTaxAmounts,
  prior: Record<string, any>[],
): HandymanTaxAmounts {
  return Object.fromEntries(
    amountKeys.map((k) => [
      k,
      decimal(money(total[k]) - prior.reduce((n, r) => n + signed(r.amounts[k]), 0n)),
    ]),
  ) as HandymanTaxAmounts;
}
export type FiscalDocumentInput = {
  kind: 'ADVANCE' | 'INSTALLMENT' | 'FINAL' | 'ADJUSTMENT';
  paymentId?: string;
  grossLabor?: string;
  grossMaterial?: string;
  taxPointAt: string;
  documentDate: string;
  externalReference: string;
  withholdingReference?: string;
  previousDocumentId?: string;
  idempotencyKey: string;
};
/** Records ACTUAL externally issued tax/withholding document references,
 * with source-derived amounts and timing validation. It never mints a DJP
 * number, submits a return or represents local data as DJP approval. */
export async function recordHandymanFiscalDocument(
  scopeId: string,
  input: FiscalDocumentInput,
  actor: string,
) {
  await financialPermission(actor);
  const key = reference(input.idempotencyKey),
    external = reference(input.externalReference),
    withholding =
      input.withholdingReference === undefined ? null : reference(input.withholdingReference),
    point = new Date(input.taxPointAt);
  if (
    !['ADVANCE', 'INSTALLMENT', 'FINAL', 'ADJUSTMENT'].includes(input.kind) ||
    !Number.isFinite(point.getTime()) ||
    point.getTime() > Date.now() ||
    !/^\d{4}-\d{2}-\d{2}$/.test(input.documentDate)
  )
    throw AppError.validation(
      'Valid fiscal document kind, actual tax point and document date are required.',
    );
  if (jakartaDate(point) !== input.documentDate || input.documentDate < '2025-05-22')
    financialConfig(
      'Supported PER-11/PJ/2025 per-event invoicing requires the actual Jakarta tax-point date. Monthly/legacy/late documents need separate reviewed handling, not invented timing.',
    );
  return withTransaction(async (tx) => {
    const scope = await financialScope(tx, scopeId, actor, true);
    await tx.query(
      'SELECT id FROM handyman_customer_transactions WHERE execution_scope_id=$1 FOR UPDATE',
      [scope.id],
    );
    const prior = (
      await tx.query(
        "SELECT * FROM handyman_fiscal_documents WHERE execution_scope_id=$1 AND side='TENANT' ORDER BY created_at,id",
        [scope.id],
      )
    ).rows;
    const replay = prior.find((r) => r.idempotency_key === key);
    if (replay) {
      if (
        replay.recorded_by_user_id !== actor ||
        replay.external_reference !== external ||
        replay.document_kind !== input.kind ||
        replay.payment_id !== (input.paymentId ?? null) ||
        replay.previous_document_id !== (input.previousDocumentId ?? null) ||
        replay.tax_point_at.toISOString() !== point.toISOString() ||
        replay.withholding_reference !== withholding ||
        (input.grossLabor !== undefined && replay.amounts.grossLabor !== input.grossLabor) ||
        (input.grossMaterial !== undefined && replay.amounts.grossMaterial !== input.grossMaterial)
      )
        financialConflict('Fiscal idempotency key was already spent on different facts.');
      return { ...replay, replayed: true };
    }
    if (prior.length && input.previousDocumentId !== prior[prior.length - 1].id)
      financialConfig(
        'Every subsequent fiscal posting must link the exact preceding fiscal document.',
      );
    if (!prior.length && input.previousDocumentId)
      financialConflict('The initial fiscal document cannot borrow another scope document.');
    const basis = await readHandymanScopeTaxBasis(
      tx,
      scope,
      ['ADVANCE', 'INSTALLMENT'].includes(input.kind),
      input.documentDate,
    );
    let total: HandymanTaxAmounts;
    if (['ADVANCE', 'INSTALLMENT'].includes(input.kind)) {
      if (!input.paymentId)
        financialConfig(
          'An exact confirmed and bank-reconciled payment is required for advance/installment tax timing.',
        );
      const p = (
        await tx.query(
          `SELECT p.*,r.actual_received_at FROM handyman_customer_payments p JOIN handyman_customer_transactions t ON t.id=p.transaction_id
        JOIN handyman_payment_reconciliations r ON r.payment_id=p.id WHERE p.id=$1 AND t.execution_scope_id=$2 AND p.status='CONFIRMED'
        AND NOT EXISTS(SELECT 1 FROM handyman_ledger_corrections c WHERE c.source_payment_id=p.id AND c.correction_kind IN ('REFUND','REVERSAL')) FOR SHARE OF p`,
          [financialId(input.paymentId), scope.id],
        )
      ).rows[0];
      if (!p || p.actual_received_at.getTime() !== point.getTime())
        financialConflict(
          'Fiscal tax point must equal the Manager-verified actual receipt time of this unreversed payment.',
        );
      const delivery = (
        await tx.query(
          `SELECT id FROM handyman_bast_documents WHERE execution_scope_id=$1 AND status='ACCEPTED' AND accepted_at<=$2`,
          [scope.id, point],
        )
      ).rows;
      for (const d of delivery)
        if (await hasVerifiedHandymanBastCustomerAcceptance(tx, d.id))
          financialConfig(
            'Payment after qualified delivery settles the existing final tax obligation; it is not a new advance.',
          );
      const labor = money(input.grossLabor ?? '0.00'),
        material = money(input.grossMaterial ?? '0.00');
      const oldL = prior.reduce((n, r) => n + signed(r.amounts.grossLabor), 0n),
        oldM = prior.reduce((n, r) => n + signed(r.amounts.grossMaterial), 0n);
      if (
        labor + material <= 0n ||
        labor + oldL > money(basis.grossLabor) ||
        material + oldM > money(basis.grossMaterial)
      )
        financialConflict('Advance fiscal gross exceeds the remaining agreed commercial basis.');
      total = calculateHandymanIndonesiaTax(
        basis.facts,
        decimal(oldL + labor),
        decimal(oldM + material),
        input.documentDate,
      );
      const amounts = subtractAmounts(total, prior);
      if (amounts.cashDue !== String(p.amount))
        financialConflict(
          'The actual verified cash is not gross less the documented qualifying withholding.',
        );
    } else {
      if (input.paymentId || input.grossLabor !== undefined || input.grossMaterial !== undefined)
        throw AppError.validation('Final/adjustment amounts are derived, not caller-selected.');
      const bast = (
        await tx.query(
          `SELECT id,status,qc_run_id,accepted_at FROM handyman_bast_documents WHERE execution_scope_id=$1 AND status NOT IN ('VOID','REJECTED') ORDER BY created_at DESC,id DESC LIMIT 1 FOR SHARE`,
          [scope.id],
        )
      ).rows[0];
      if (
        !bast?.accepted_at ||
        bast.status !== 'ACCEPTED' ||
        !(await hasVerifiedHandymanBastCustomerAcceptance(tx, bast.id))
      )
        financialConfig(
          'Final fiscal posting requires the canonical qualified customer BAST receipt, not a raw ACCEPTED status.',
        );
      await assertCurrentGuardedHandymanQcPass(
        tx,
        { id: scope.id, clientId: scope.client_id, buildingId: scope.building_id },
        bast.qc_run_id,
      );
      if (input.kind === 'FINAL' && jakartaDate(bast.accepted_at) !== input.documentDate)
        financialConfig(
          'Final/delivery tax posting needs the actual qualified BAST delivery date.',
        );
      if (input.kind === 'ADJUSTMENT' && input.documentDate < jakartaDate(bast.accepted_at))
        financialConfig(
          'Pre-delivery advance cancellation needs separately reviewed compensation, not a final-delivery adjustment.',
        );
      if (
        input.kind === 'ADJUSTMENT' &&
        (!input.previousDocumentId || !prior.some((r) => r.id === input.previousDocumentId))
      )
        financialConfig(
          'An actual replacement/cancellation reference linked to the original fiscal document is required for adjustments.',
        );
      total = calculateHandymanIndonesiaTax(
        basis.facts,
        basis.grossLabor,
        basis.grossMaterial,
        input.documentDate,
      );
    }
    const amounts = subtractAmounts(total, prior);
    if (amountKeys.every((k) => signed(amounts[k]) === 0n))
      financialConflict(
        'No remaining fiscal amount; repeated allocation/final settlement must not charge VAT twice.',
      );
    if (signed(amounts.gross) < 0n && input.kind !== 'ADJUSTMENT')
      financialConflict(
        'A reduction of issued fiscal amounts needs an explicit linked adjustment document.',
      );
    if (signed(amounts.withholding) !== 0n) reference(withholding);
    if (signed(amounts.withholding) < 0n)
      financialConfig(
        'Withholding certificate cancellation/replacement requires a separately reviewed compensation; never silently reverse a certified tax credit.',
      );
    if (
      (
        await tx.query(
          `SELECT id FROM handyman_fiscal_documents WHERE (issuer_reference=$1 AND external_reference=$2)
      OR (payer_reference=$3 AND withholding_reference=$4) LIMIT 1`,
          [basis.facts.incomeRecipientReference, external, basis.facts.payerReference, withholding],
        )
      ).rowCount
    )
      financialConflict(
        'The actual issuer document or payer withholding certificate was already used, including on another quotation/profile.',
      );
    const row = (
      await tx.query(
        `INSERT INTO handyman_fiscal_documents(id,execution_scope_id,profile_id,side,document_kind,payment_id,previous_document_id,tax_point_at,document_date,external_reference,withholding_reference,amounts,recorded_by_user_id,idempotency_key,issuer_reference,payer_reference)
      VALUES($1,$2,$3,'TENANT',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [
          randomUUID(),
          scope.id,
          basis.profile.id,
          input.kind,
          input.paymentId ?? null,
          input.previousDocumentId ?? null,
          point,
          input.documentDate,
          external,
          withholding,
          JSON.stringify(amounts),
          actor,
          key,
          basis.facts.incomeRecipientReference,
          basis.facts.payerReference,
        ],
      )
    ).rows[0];
    await recordOperationalEvent(
      {
        clientId: scope.client_id,
        buildingId: scope.building_id,
        actorUserId: actor,
        eventType: 'HANDYMAN_FISCAL_DOCUMENT_RECORDED',
        entityType: 'HANDYMAN_FISCAL_DOCUMENT',
        entityId: row.id,
        summary:
          'Actual external fiscal reference reconciled; not a DJP-issued document generated by this backend.',
        metadata: {
          scopeId: scope.id,
          kind: input.kind,
          gross: amounts.gross,
          vat: amounts.vat,
          withholding: amounts.withholding,
        },
      },
      tx,
    );
    return { ...row, replayed: false };
  });
}
export async function applyHandymanWithholdingCredit(
  scopeId: string,
  documentId: string,
  actor: string,
) {
  await financialPermission(actor);
  return withTransaction(async (tx) => {
    const scope = await financialScope(tx, scopeId, actor, true);
    await tx.query(
      'SELECT id FROM handyman_customer_transactions WHERE execution_scope_id=$1 FOR UPDATE',
      [scope.id],
    );
    const d = (
      await tx.query(
        "SELECT * FROM handyman_fiscal_documents WHERE id=$1 AND execution_scope_id=$2 AND side='TENANT'",
        [financialId(documentId), scope.id],
      )
    ).rows[0];
    if (!d) throw AppError.notFound();
    const prior = (
      await tx.query(
        'SELECT wc.*,c.corrected_by_user_id FROM handyman_fiscal_withholding_credits wc JOIN handyman_ledger_corrections c ON c.id=wc.correction_id WHERE wc.document_id=$1',
        [d.id],
      )
    ).rows[0];
    if (prior) {
      if (prior.corrected_by_user_id !== actor)
        financialConflict('Withholding credit replay belongs to its original authorized actor.');
      return { ...prior, replayed: true };
    }
    if (!d.withholding_reference || money(d.amounts.withholding) <= 0n)
      financialConflict(
        'An actual positive verified withholding certificate is required; no synthetic received-funds payment.',
      );
    const line = (
      await tx.query(
        `SELECT l.id FROM handyman_charge_lines l JOIN handyman_customer_transactions t ON t.id=l.transaction_id
      WHERE t.execution_scope_id=$1 AND l.line_kind='LABOR' AND l.amount-COALESCE((SELECT SUM(c.amount) FROM handyman_ledger_corrections c
        WHERE c.source_charge_line_id=l.id AND c.correction_kind='ADJUSTMENT'),0)>=$2 ORDER BY l.id LIMIT 1`,
        [scope.id, d.amounts.withholding],
      )
    ).rows[0];
    if (!line)
      financialConfig(
        'A posted eligible LABOR receivable with sufficient headroom is required; certificate credit is not cash and cannot be prorated across arbitrary lines.',
      );
    const correction = await adjustHandymanCustomerLedger(
      {
        executionScopeId: scope.id,
        chargeLineId: line.id,
        amount: d.amounts.withholding,
        reason: `Certified withholding credit ${d.withholding_reference}`,
        idempotencyKey: `fiscal-withholding:${d.id}`,
      },
      actor,
      tx,
    );
    const row = (
      await tx.query(
        'INSERT INTO handyman_fiscal_withholding_credits(document_id,correction_id) VALUES($1,$2) RETURNING *',
        [d.id, correction.correction.id],
      )
    ).rows[0];
    await recordOperationalEvent(
      {
        clientId: scope.client_id,
        buildingId: scope.building_id,
        actorUserId: actor,
        eventType: 'HANDYMAN_WITHHOLDING_CREDIT_RECORDED',
        entityType: 'HANDYMAN_FISCAL_DOCUMENT',
        entityId: d.id,
        summary:
          'Noncash certified withholding credited once through the existing forward-only ledger.',
        metadata: { correctionId: correction.correction.id, amount: d.amounts.withholding },
      },
      tx,
    );
    return { ...row, replayed: false };
  });
}
export async function assessHandymanTax(tx: FinancialExecutor, scope: Record<string, any>) {
  const basis = await readHandymanScopeTaxBasis(tx, scope);
  const amounts = calculateHandymanIndonesiaTax(basis.facts, basis.grossLabor, basis.grossMaterial);
  const docs = (
    await tx.query(
      "SELECT * FROM handyman_fiscal_documents WHERE execution_scope_id=$1 AND side='TENANT' ORDER BY created_at,id",
      [scope.id],
    )
  ).rows;
  const posted = Object.fromEntries(
    amountKeys.map((k) => [k, decimal(docs.reduce((n, r) => n + signed(r.amounts[k]), 0n))]),
  ) as HandymanTaxAmounts;
  const wh = (
    await tx.query(
      `SELECT COALESCE(SUM(c.amount),0)::numeric(18,2)::text amount FROM handyman_fiscal_withholding_credits wc
    JOIN handyman_ledger_corrections c ON c.id=wc.correction_id JOIN handyman_fiscal_documents d ON d.id=wc.document_id WHERE d.execution_scope_id=$1`,
      [scope.id],
    )
  ).rows[0].amount;
  const changedReceipts = (
    await tx.query(
      `SELECT d.id FROM handyman_fiscal_documents d JOIN handyman_ledger_corrections c ON c.source_payment_id=d.payment_id
    WHERE d.execution_scope_id=$1 AND d.side='TENANT' AND c.correction_kind IN ('REFUND','REVERSAL') LIMIT 1`,
      [scope.id],
    )
  ).rowCount;
  const needDocs = basis.facts.providerStatus === 'PKP' || basis.facts.incomeTax !== 'NONE';
  const complete = !needDocs || amountKeys.every((k) => amounts[k] === posted[k]);
  const withholdingReconciled = String(wh) === amounts.withholding;
  return {
    configured: true,
    profileId: basis.profile.id,
    facts: basis.facts,
    basisSource: basis.basisSource,
    amounts,
    posted,
    withholdingCredit: String(wh),
    documents: docs,
    fiscalReadinessOnly: true,
    readyForInvoice: complete && withholdingReconciled && !changedReceipts,
    missing: [
      ...(changedReceipts ? ['REFUNDED_ADVANCE_FISCAL_COMPENSATION_REQUIRED'] : []),
      ...(!complete ? ['ACTUAL_FISCAL_DOCUMENTS_NOT_RECONCILED'] : []),
      ...(!withholdingReconciled ? ['CERTIFIED_WITHHOLDING_CREDIT_NOT_POSTED'] : []),
    ],
    djpSubmission: false,
  };
}
export async function readHandymanTaxReconciliation(scopeId: string, actor: string) {
  await financialPermission(actor, 'handyman.finance.read');
  const tx = getPool(),
    scope = await financialScope(tx, scopeId, actor);
  const transaction = (
    await tx.query('SELECT id FROM handyman_customer_transactions WHERE execution_scope_id=$1', [
      scope.id,
    ])
  ).rows[0];
  const cashLedger = transaction
    ? (await readHandymanLedgerTransactionAt(scope.id, actor)).totals
    : null;
  try {
    return { ...(await assessHandymanTax(tx, scope)), cashLedger };
  } catch (e) {
    if (e instanceof AppError && e.code === 'HANDYMAN_FINANCIAL_CONFIGURATION_REQUIRED')
      return {
        configured: false,
        readyForInvoice: false,
        missing: [e.message],
        cashLedger,
        djpSubmission: false,
      };
    throw e;
  }
}
/** Commercial invoices are not tax invoices. Once a quotation explicitly opts
 * into reviewed fiscal treatment, its invoice may not silently omit VAT/WH
 * obligations or outstanding actual document/certificate references. */
export async function assertConfiguredHandymanInvoiceTax(tx: FinancialExecutor, scopeId: string) {
  const scope = (
    await tx.query('SELECT * FROM handyman_execution_scopes WHERE id=$1 FOR SHARE', [scopeId])
  ).rows[0];
  if (!scope) return;
  const configured = (
    await tx.query('SELECT id FROM handyman_financial_tax_profiles WHERE quotation_version_id=$1', [
      scope.approved_quotation_version_id,
    ])
  ).rows[0];
  if (!configured) return; // legacy commercial-only invoice, NOT fiscal certification
  await tx.query(
    'SELECT id FROM handyman_customer_transactions WHERE execution_scope_id=$1 FOR UPDATE',
    [scopeId],
  );
  const assessment = await assessHandymanTax(tx, scope);
  if (!assessment.readyForInvoice)
    financialConfig(`Fiscal obligations are incomplete: ${assessment.missing.join(', ')}.`);
}

/** CR-HM-14 still owns the percentage calculation. This adapter only supplies
 * its configured LABOR_ONLY basis EXCLUDING VAT and certified noncash credits.
 * A missing tenant profile preserves legacy commercial-only reads, never
 * asserts that a legacy transaction was fiscally verified. */
export async function handymanBmFeeFiscalBasis(
  tx: FinancialExecutor,
  scopeId: string,
  agreementVersionId: string,
  laborNet: string,
) {
  const scope = (await tx.query('SELECT * FROM handyman_execution_scopes WHERE id=$1', [scopeId]))
    .rows[0];
  const tenant = (
    await tx.query('SELECT * FROM handyman_financial_tax_profiles WHERE quotation_version_id=$1', [
      scope.approved_quotation_version_id,
    ])
  ).rows[0];
  if (!tenant) return { laborBasis: laborNet, tenantProfileId: null, bmProfileId: null };
  const bm = (
    await tx.query('SELECT * FROM handyman_financial_tax_profiles WHERE agreement_version_id=$1', [
      agreementVersionId,
    ])
  ).rows[0];
  if (!bm)
    financialConfig(
      'The cooperation contract needs its own BM taxpayer/service/timing facts; tenant tax status cannot be borrowed.',
    );
  if (
    validateHandymanTaxFacts(bm.facts).payerReference !==
    validateHandymanTaxFacts(tenant.facts).incomeRecipientReference
  )
    financialConfig(
      'The BM fee payer must be the actual Handyman income recipient, not the tenant or another taxpayer.',
    );
  if (validateHandymanTaxFacts(bm.facts).bmSettlementTiming !== 'AFTER_FULL_CUSTOMER_COLLECTION')
    financialConfig('No supported, explicit BM settlement timing is configured.');
  const certified = (
    await tx.query(
      `SELECT COALESCE(SUM((d.amounts->>'withholding')::numeric),0)::numeric(18,2)::text amount
    FROM handyman_fiscal_withholding_credits wc JOIN handyman_fiscal_documents d ON d.id=wc.document_id WHERE d.execution_scope_id=$1`,
      [scopeId],
    )
  ).rows[0].amount;
  // All certified credits admitted by this adapter are explicitly LABOR-bound.
  // Restore that NONCASH credit, then remove VAT from the published laborNet.
  const tax = calculateHandymanIndonesiaTax(
    validateHandymanTaxFacts(tenant.facts),
    decimal(money(laborNet) + money(certified)),
    '0.00',
  );
  return {
    laborBasis: tax.serviceNet,
    tenantProfileId: tenant.id as string,
    bmProfileId: bm.id as string,
  };
}
export async function recordHandymanBmFiscalDocument(
  scopeId: string,
  input: {
    taxPointAt: string;
    documentDate: string;
    externalReference: string;
    withholdingReference?: string;
    reconciliationReference: string;
    idempotencyKey: string;
  },
  actor: string,
) {
  await financialPermission(actor, 'handyman.settlement.manage');
  const key = reference(input.idempotencyKey),
    external = reference(input.externalReference),
    bank = reference(input.reconciliationReference),
    withholding =
      input.withholdingReference === undefined ? null : reference(input.withholdingReference),
    point = new Date(input.taxPointAt);
  if (
    !Number.isFinite(point.getTime()) ||
    point.getTime() > Date.now() ||
    jakartaDate(point) !== input.documentDate
  )
    financialConfig(
      'An actual BM tax point, document date and outgoing payment reconciliation are required.',
    );
  return withTransaction(async (tx) => {
    const scope = await financialScope(tx, scopeId, actor, true);
    await tx.query(
      'SELECT id FROM handyman_customer_transactions WHERE execution_scope_id=$1 FOR UPDATE',
      [scope.id],
    );
    const entitlement = (
      await tx.query(
        `SELECT f.*,b.bm_profile_id,p.facts FROM handyman_entitlement_facts f
      JOIN handyman_bm_fee_fiscal_bases b ON b.entitlement_id=f.id JOIN handyman_financial_tax_profiles p ON p.id=b.bm_profile_id
      WHERE f.execution_scope_id=$1 AND f.entitlement_kind='BM_FEE'`,
        [scope.id],
      )
    ).rows[0];
    if (!entitlement)
      financialConfig(
        'An existing contract-derived BM entitlement and separate BM fiscal basis are required.',
      );
    if (
      (
        await tx.query('SELECT id FROM handyman_entitlement_corrections WHERE entitlement_id=$1', [
          entitlement.id,
        ])
      ).rowCount
    )
      financialConfig(
        'A corrected BM claim needs a reviewed replacement fiscal document, not reuse of its original payable.',
      );
    const facts = validateHandymanTaxFacts(entitlement.facts);
    const amounts = calculateHandymanIndonesiaTax(
      facts,
      String(entitlement.amount),
      '0.00',
      input.documentDate,
    );
    if (money(amounts.withholding) > 0n) reference(withholding);
    const prior = (
      await tx.query(
        "SELECT * FROM handyman_fiscal_documents WHERE execution_scope_id=$1 AND side='BM'",
        [scope.id],
      )
    ).rows;
    if (prior.length) {
      const same = prior.find(
        (d) =>
          d.idempotency_key === key &&
          d.recorded_by_user_id === actor &&
          d.external_reference === external &&
          d.reconciliation_reference === bank &&
          d.withholding_reference === withholding &&
          d.tax_point_at.toISOString() === point.toISOString(),
      );
      if (!same)
        financialConflict(
          'BM fee fiscal obligation was already documented; no duplicate settlement or rewritten certificate.',
        );
      return { ...same, replayed: true };
    }
    const row = (
      await tx.query(
        `INSERT INTO handyman_fiscal_documents(id,execution_scope_id,profile_id,side,document_kind,entitlement_id,tax_point_at,document_date,external_reference,withholding_reference,reconciliation_reference,amounts,recorded_by_user_id,idempotency_key,issuer_reference,payer_reference)
      VALUES($1,$2,$3,'BM','BM_FEE',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [
          randomUUID(),
          scope.id,
          entitlement.bm_profile_id,
          entitlement.id,
          point,
          input.documentDate,
          external,
          withholding,
          bank,
          JSON.stringify(amounts),
          actor,
          key,
          facts.incomeRecipientReference,
          facts.payerReference,
        ],
      )
    ).rows[0];
    await recordOperationalEvent(
      {
        clientId: scope.client_id,
        buildingId: scope.building_id,
        actorUserId: actor,
        eventType: 'HANDYMAN_BM_FISCAL_RECONCILED',
        entityType: 'HANDYMAN_FISCAL_DOCUMENT',
        entityId: row.id,
        summary:
          'Independent BM fee gross payable, VAT, withholding and verified cash reference recorded.',
        metadata: {
          entitlementId: entitlement.id,
          gross: amounts.gross,
          cashDue: amounts.cashDue,
          withholding: amounts.withholding,
        },
      },
      tx,
    );
    return { ...row, replayed: false };
  });
}
export async function assertHandymanBmFiscalSettlement(tx: FinancialExecutor, scopeId: string) {
  const governed = (
    await tx.query(
      `SELECT f.id FROM handyman_entitlement_facts f JOIN handyman_bm_fee_fiscal_bases b ON b.entitlement_id=f.id WHERE f.execution_scope_id=$1`,
      [scopeId],
    )
  ).rows;
  if (!governed.length) return; // legacy commercial settlement is not tax certification
  await tx.query(
    'SELECT id FROM handyman_customer_transactions WHERE execution_scope_id=$1 FOR UPDATE',
    [scopeId],
  );
  const docs = (
    await tx.query(
      "SELECT * FROM handyman_fiscal_documents WHERE execution_scope_id=$1 AND side='BM'",
      [scopeId],
    )
  ).rows;
  if (
    (
      await tx.query(
        'SELECT c.id FROM handyman_entitlement_corrections c JOIN handyman_bm_fee_fiscal_bases b ON b.entitlement_id=c.entitlement_id JOIN handyman_entitlement_facts f ON f.id=c.entitlement_id WHERE f.execution_scope_id=$1 LIMIT 1',
        [scopeId],
      )
    ).rowCount
  )
    financialConfig(
      'Corrected BM entitlements require a reviewed replacement fiscal reconciliation before settlement.',
    );
  if (
    docs.length !== 1 ||
    !governed.some((g) => g.id === docs[0].entitlement_id) ||
    !docs[0].reconciliation_reference
  )
    financialConfig(
      'The configured BM payable requires its own actual fiscal/cash/withholding reconciliation before SETTLED.',
    );
}
