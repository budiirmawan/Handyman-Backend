import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { stableJson } from '../../shared/stable-json';
import { isValidUuid } from '../clients';
import { assertBuildingScopedResourceAccess } from '../context-access';
import { resolveBuildingsForUser } from '../building-assignments';
import { permissionRepository } from '../permissions';
import { resolveCareWorkspacePrincipal, workspaceUnauthorized } from '../handyman-care-workspace/care-workspace.service';
import { parseCareHandymanPaymentProofSelection } from '../handyman-care-workspace/care-workspace-payment-proof.service';
import { WORKSPACE_OCCUPANCY_CTES } from '../handyman-care-workspace/care-workspace-occupancies.repository';
import { resolveHandymanDocumentIssuerSnapshot } from '../handyman-documents/handyman-document-issuer.service';
import { handymanDocumentIssuerProfileRepository } from '../handyman-documents/handyman-document-issuer.repository';
import { resolveHandymanDocumentSettingsSnapshot } from '../handyman-documents/handyman-document-settings.service';
import { renderHandymanDocumentPdf } from '../handyman-documents/handyman-document-pdf';
import type { HandymanDocumentLocale } from '../handyman-documents/handyman-document-pdf.types';
import { hasVerifiedHandymanBastCustomerAcceptance } from '../handyman-bast';
import { verifyStoredOfficialBast, type OfficialBastStored } from '../handyman-bast/handyman-bast-document.service';
import { requireVerifiedCompletionForIssue, type ManifestItem } from '../handyman-completion-manifest/handyman-completion-manifest.service';
import { assertHandymanQuotationPricingAuthority } from '../handyman-quotations/handyman-quotation-access';
import { addText, blocks, exactText, verifyStoredQuotationDocument, type QuotationDocumentStored } from '../handyman-quotations/handyman-quotation-document.service';
import { QUOTATION_WARRANTY_PROTOCOL, VARIATION_WARRANTY_PROTOCOL, parseWarrantyTerms, type WarrantyTerms } from '../handyman-quotations/handyman-quotation-warranty-terms';
import { verifyStoredVariationOffer, type VariationOfferStored } from '../handyman-scope-variations/handyman-variation-offer-document.service';
import { handymanScopeVariationRepository } from '../handyman-scope-variations/handyman-scope-variation.repository';
import { assertPinnedVariationApproval } from '../handyman-scope-variations/handyman-scope-variation-material-authority';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const conflict = (message: string) => new AppError({ code: ERROR_CODES.HANDYMAN_WARRANTY_CERTIFICATE_CONFLICT, statusCode: 409, message });
const integrity = () => new AppError({ code: ERROR_CODES.HANDYMAN_WARRANTY_CERTIFICATE_INTEGRITY_ERROR, statusCode: 409,
  message: 'The warranty certificate or its frozen source failed integrity verification.' });
const notFound = () => AppError.notFound('Official warranty certificate not found.');
function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isValidUuid(value)) throw AppError.validation(`Invalid ${field}.`);
  return value.toLowerCase();
}
type AgreementRef = { kind: 'QUOTATION' | 'ADD' | 'AMEND'; lineId: string; variationId: string | null;
  decisionId: string; documentId: string; number: string; version: number; sourceSha256: string; pdfSha256: string };
type Edge = { predecessorLineId: string; successorLineId: string; variationId: string; offerDocumentId: string; tenantDecisionEventId: string };
type Item = { rootLineId: string; quotationVersionId: string; variationId: string | null; description: string; lineType: string;
  actualQty: string; unit: string; terms: WarrantyTerms; startsAt: string; endsAtExclusive: string; agreementChain: AgreementRef[] };
type Source = {
  schema: 'HANDYMAN_WARRANTY_CERTIFICATE_V1'; status: 'ISSUED';
  issuance: { id: string; number: string; actorUserId: string; issuedAt: string };
  context: { clientId: string; clientName: string; buildingId: string; buildingName: string; requestId: string;
    tenantCompanyId: string; tenantName: string; tenantLegalName: string | null; spaceId: string | null; executionScopeId: string };
  warranty: { id: string }; bast: { id: string; acceptedAt: string; documentId: string; number: string; sourceSha256: string; pdfSha256: string;
    snapshot: OfficialBastStored['source_snapshot'] };
  manifest: OfficialBastStored['source_snapshot']['manifest'];
  approvedQuotation: OfficialBastStored['source_snapshot']['approvedQuotation'];
  quotation: { documentId: string; number: string; sourceSha256: string; pdfSha256: string; snapshot: QuotationDocumentStored['source_snapshot'] } | null;
  variations: Array<{ documentId: string; variationId: string; number: string; version: number; sourceSha256: string;
    pdfSha256: string; snapshot: VariationOfferStored['source_snapshot'] }>;
  edges: Edge[]; items: Item[];
  issuer: Awaited<ReturnType<typeof resolveHandymanDocumentIssuerSnapshot>>;
  settings: Awaited<ReturnType<typeof resolveHandymanDocumentSettingsSnapshot>>;
};
type Stored = { id: string; client_id: string; building_id: string; request_id: string; tenant_company_id: string;
  execution_scope_id: string; warranty_id: string; bast_id: string; bast_official_id: string; completion_verification_id: string;
  manifest_id: string; manifest_version: number; manifest_sha256: string; issuer_profile_id: string; settings_id: string;
  document_number: string; issued_by_user_id: string; issued_at: Date; idempotency_key: string; source_snapshot: Source;
  source_canonical: string; source_sha256: string; pdf_filename: string; pdf_bytes: Buffer; pdf_size: number; pdf_sha256: string };

type VariationPin = { id: string; type: string; approvedVersion: number; decisionEventId: string; authorizationEventId: string };
async function readEdges(tx: Pick<PoolClient, 'query'>, scopeId: string): Promise<Edge[]> {
  return (await tx.query<Edge>(`SELECT predecessor_line_id AS "predecessorLineId",successor_line_id AS "successorLineId",
    variation_id AS "variationId",offer_document_id AS "offerDocumentId",tenant_decision_event_id AS "tenantDecisionEventId"
    FROM handyman_warranty_term_supersessions WHERE execution_scope_id=$1 ORDER BY predecessor_line_id`, [scopeId])).rows;
}
function parseExactTerms(w: WarrantyTerms | undefined): WarrantyTerms | null {
  if (!w) return null;
  try {
    const parsed = parseWarrantyTerms(w).warrantyTerms;
    return stableJson(parsed) === stableJson(w) ? parsed : null;
  } catch { return null; }
}
function verifyCertificate(row: Stored) {
  try {
    const s = row.source_snapshot;
    if (!Buffer.isBuffer(row.pdf_bytes) || row.pdf_bytes.length !== row.pdf_size || row.pdf_size < 1 || row.pdf_size > 10485760 ||
        row.pdf_bytes.subarray(0,5).toString() !== '%PDF-' || sha(row.pdf_bytes) !== row.pdf_sha256 ||
        !/^warranty-[a-z0-9-]+\.pdf$/.test(row.pdf_filename) || stableJson(s) !== row.source_canonical || sha(row.source_canonical) !== row.source_sha256 ||
        s.schema !== 'HANDYMAN_WARRANTY_CERTIFICATE_V1' || s.status !== 'ISSUED' || s.issuance.id !== row.id ||
        s.issuance.number !== row.document_number || s.issuance.actorUserId !== row.issued_by_user_id ||
        s.issuance.issuedAt !== row.issued_at.toISOString() || s.context.clientId !== row.client_id || s.context.buildingId !== row.building_id ||
        s.context.requestId !== row.request_id || s.context.tenantCompanyId !== row.tenant_company_id || s.context.executionScopeId !== row.execution_scope_id ||
        s.warranty.id !== row.warranty_id || s.bast.id !== row.bast_id || s.bast.documentId !== row.bast_official_id ||
        sha(stableJson(s.bast.snapshot)) !== s.bast.sourceSha256 ||
        s.manifest.id !== row.manifest_id || s.manifest.version !== row.manifest_version || s.manifest.sha256 !== row.manifest_sha256 ||
        sha(stableJson(s.manifest.snapshot)) !== row.manifest_sha256 || s.issuer.profileId !== row.issuer_profile_id ||
        s.settings.settingsId !== row.settings_id || !s.items.length || s.items.some(item => !parseExactTerms(item.terms) || item.terms.coverage === 'NONE') ||
        (s.quotation && sha(stableJson(s.quotation.snapshot)) !== s.quotation.sourceSha256) ||
        s.variations.some(v => sha(stableJson(v.snapshot)) !== v.sourceSha256)) throw integrity();
  } catch { throw integrity(); }
  return { id: row.id, number: row.document_number, filename: row.pdf_filename, fileSize: row.pdf_size,
    sourceChecksum: row.source_sha256, pdfChecksum: row.pdf_sha256, bytes: row.pdf_bytes };
}
async function render(s: Source, sourceHash: string) {
  const lineItems: {description: string}[] = [];
  s.items.forEach((item,index) => {
    const rows: string[] = [];
    addText(rows, `Covered item ${index+1} ${item.lineType}`, item.description);
    addText(rows, 'Completed quantity', `${item.actualQty} ${item.unit}`); addText(rows, 'Completed quotation line ID', item.rootLineId);
    addText(rows, 'Agreed coverage', item.terms.coverage); addText(rows, 'Covered services', item.terms.coveredServices);
    addText(rows, 'Covered materials', item.terms.coveredMaterials); addText(rows, 'Conditions', item.terms.conditions);
    addText(rows, 'Exclusions', item.terms.exclusions); addText(rows, 'Contractual start UTC', item.startsAt);
    addText(rows, 'Contractual end UTC (exclusive)', item.endsAtExclusive);
    if (item.terms.endRule === 'DURATION_DAYS') addText(rows, 'End rule', `${item.terms.durationDays} consecutive 24-hour days from acceptance`);
    else addText(rows, 'End rule', `Through ${item.terms.fixedEndDate} inclusive in Asia/Jakarta`);
    for (const a of item.agreementChain) {
      addText(rows, `Agreed ${a.kind}`, `${a.number}, version ${a.version}`); addText(rows, 'Offer document ID', a.documentId);
      addText(rows, 'Offer PDF SHA-256', a.pdfSha256); addText(rows, 'Agreed quotation line ID', a.lineId);
    }
    rows.forEach(description => lineItems.push({description}));
  });
  const context: string[] = [];
  addText(context, 'Client', `${s.context.clientName} / ${s.context.clientId}`);
  addText(context, 'Building', `${s.context.buildingName} / ${s.context.buildingId}`);
  addText(context, 'Tenant', s.context.tenantName); addText(context, 'Tenant legal name', s.context.tenantLegalName);
  addText(context, 'Request ID', s.context.requestId); addText(context, 'Execution scope ID', s.context.executionScopeId);
  addText(context, 'Warranty lifecycle ID', s.warranty.id);
  addText(context, 'Accepted BAST', `${s.bast.number} / ${s.bast.id}`); addText(context, 'BAST acceptance UTC', s.bast.acceptedAt);
  addText(context, 'BAST PDF SHA-256', s.bast.pdfSha256);
  addText(context, 'Approved quotation version', `${s.approvedQuotation.id} / ${s.approvedQuotation.versionNumber}`);
  addText(context, 'Verified completion manifest', `${s.manifest.id} / version ${s.manifest.version}`);
  addText(context, 'Manifest SHA-256', s.manifest.sha256);
  const notes: string[] = [];
  addText(notes, 'Coverage', 'Only the completed items listed are covered, subject to the exact agreed terms and dates.');
  addText(notes, 'Expiry', 'The contractual end is separate from any warranty lifecycle EXPIRE event.');
  addText(notes, 'Issuer contact', s.settings.contactNote); addText(notes, 'Footer', s.settings.footerNote);
  addText(notes, 'Designated issuer (not a signature)', `${s.settings.signatoryName} / ${s.settings.signatoryTitle}`);
  addText(notes, 'Source SHA-256', sourceHash);
  const allTerms = [...blocks('Customer, scope and acceptance',context),...blocks('Notes',notes)];
  if (lineItems.length>400 || allTerms.length>12) throw conflict('Warranty source exceeds the complete PDF layout capacity.');
  return renderHandymanDocumentPdf({ locale:s.settings.language, utcOffsetMinutes:0,
    document:{kind:'WARRANTY_CERTIFICATE',number:s.issuance.number,issueDate:s.issuance.issuedAt,reference:s.context.requestId},
    issuer:{name:exactText(s.issuer.legalName),addressLines:[exactText(s.issuer.registeredAddress),
      exactText(`${s.issuer.city}, ${s.issuer.province} ${s.issuer.postalCode}`)], phone:exactText(s.issuer.phone),email:exactText(s.issuer.email)},
    recipient:{name:exactText(s.context.tenantName)},property:{name:exactText(s.context.buildingName)},lineItems,terms:allTerms,
    status:{value:'ISSUED',lines:['Contractual periods are shown per item; this document does not record a signature.']},
  },{filename:`warranty-${s.issuance.number.toLowerCase()}.pdf`});
}

/** Issue exactly once against the caller-reviewed accepted BAST and verified manifest. */
export async function issueWarrantyCertificate(actorInput: string, input: { executionScopeId: string; warrantyId: unknown; bastId: unknown;
  manifestId: unknown; manifestVersion: unknown; manifestSha256: unknown; idempotencyKey: unknown; documentLanguage?: unknown }) {
  const actor=uuid(actorInput,'actorUserId'), scopeId=uuid(input?.executionScopeId,'executionScopeId'), warrantyId=uuid(input?.warrantyId,'warrantyId');
  const bastId=uuid(input?.bastId,'bastId'),manifestId=uuid(input?.manifestId,'manifestId');
  if (!Number.isSafeInteger(input.manifestVersion) || Number(input.manifestVersion)<1 || typeof input.manifestSha256!=='string' ||
      !/^[0-9a-f]{64}$/.test(input.manifestSha256) || typeof input.idempotencyKey!=='string' || !input.idempotencyKey.trim() ||
      input.idempotencyKey.trim().length>128 || (input.documentLanguage!==undefined && !['id','en'].includes(String(input.documentLanguage))))
    throw AppError.validation('Exact manifest version/hash, idempotency key and optional document language are required.');
  const key=input.idempotencyKey.trim(), languageInput=input.documentLanguage as HandymanDocumentLocale | undefined;
  try {
    return await withTransaction(async tx => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      // READ COMMITTED after the common scope lock observes the latest committed
      // variation, completion and BAST writers; the unique warranty index is the duplicate fence.
      const scope=(await tx.query<{id:string;clientId:string;buildingId:string;handymanRequestId:string;tenantCompanyId:string;status:string}>(`SELECT id,client_id AS "clientId",building_id AS "buildingId",
        handyman_request_id AS "handymanRequestId",tenant_company_id AS "tenantCompanyId",status FROM handyman_execution_scopes WHERE id=$1 FOR UPDATE`,[scopeId])).rows[0];
      if (!scope) throw notFound();
      const user=(await tx.query<{status:string}>('SELECT status FROM users WHERE id=$1',[actor])).rows[0];
      if (user?.status!=='ACTIVE') throw new AppError({code:ERROR_CODES.PERMISSION_DENIED,statusCode:403,message:'Active Operations authority required.'});
      await assertBuildingScopedResourceAccess(actor,{clientId:scope.clientId,buildingId:scope.buildingId},tx);
      await assertHandymanQuotationPricingAuthority({clientId:scope.clientId,handymanRequestId:scope.handymanRequestId,actorUserId:actor},tx);
      const existing=(await tx.query<Stored>('SELECT * FROM handyman_warranty_certificates WHERE execution_scope_id=$1 AND (warranty_id=$2 OR idempotency_key=$3)',[scopeId,warrantyId,key])).rows[0];
      if (existing) {
        if (existing.warranty_id!==warrantyId || existing.idempotency_key!==key || existing.bast_id!==bastId ||
            existing.manifest_id!==manifestId || existing.manifest_version!==input.manifestVersion || existing.manifest_sha256!==input.manifestSha256 ||
            existing.issued_by_user_id!==actor || (languageInput && existing.source_snapshot.settings.language!==languageInput)) throw conflict('Warranty certificate already issued or idempotency key belongs to other facts.');
        const d=verifyCertificate(existing);
        await assertCurrent(tx,existing); return {id:d.id,number:d.number,sourceChecksum:d.sourceChecksum,pdfChecksum:d.pdfChecksum,replayed:true};
      }
      const anchor=(await tx.query<{acceptedAt:string;clientName:string;qcRunId:string}>(`SELECT
        to_char(b.accepted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "acceptedAt",c.name AS "clientName",b.qc_run_id AS "qcRunId"
        FROM handyman_service_warranties w JOIN handyman_bast_documents b ON b.id=w.bast_id AND b.client_id=w.client_id AND b.execution_scope_id=w.execution_scope_id
        JOIN clients c ON c.id=w.client_id WHERE w.id=$1 AND w.execution_scope_id=$2 AND w.client_id=$3
          AND b.id=$4 AND b.status='ACCEPTED' AND b.accepted_at IS NOT NULL AND w.starts_at=b.accepted_at AND w.bast_accepted_at=b.accepted_at
          AND EXISTS (SELECT 1 FROM handyman_service_warranty_events e WHERE e.warranty_id=w.id AND e.execution_scope_id=w.execution_scope_id
            AND e.bast_id=b.id AND e.event_type='START') FOR SHARE OF w,b,c`,[warrantyId,scopeId,scope.clientId,bastId])).rows[0];
      if (!anchor || !(await hasVerifiedHandymanBastCustomerAcceptance(tx,bastId))) throw conflict('The lifecycle warranty requires the exact independently accepted BAST.');
      const bast=(await tx.query<OfficialBastStored>('SELECT * FROM handyman_bast_official_documents WHERE bast_id=$1 AND execution_scope_id=$2',[bastId,scopeId])).rows[0];
      if (!bast) throw conflict('Historical BAST has no verified official completion artifact; do not backfill it.');
      verifyStoredOfficialBast(bast);
      const completion=await requireVerifiedCompletionForIssue(tx,scope,anchor.qcRunId);
      if (completion.verificationId!==bast.completion_verification_id || completion.manifestId!==manifestId || completion.manifestId!==bast.manifest_id ||
          completion.manifestVersion!==input.manifestVersion || completion.manifestSha256!==input.manifestSha256 ||
          completion.manifestSha256!==bast.manifest_sha256) throw conflict('The accepted BAST or reviewed completion version is stale.');
      const decision=(await tx.query<{offer_document_id:string|null;offer_source_sha256:string|null;offer_pdf_sha256:string|null}>(`SELECT d.offer_document_id,d.offer_source_sha256,d.offer_pdf_sha256
        FROM handyman_execution_scopes s JOIN handyman_quotation_decisions d ON d.id=s.quotation_decision_id AND d.client_id=s.client_id
          AND d.quotation_id=s.quotation_id AND d.quotation_version_id=s.approved_quotation_version_id AND d.tenant_company_id=s.tenant_company_id
          AND d.decision='APPROVE' WHERE s.id=$1`,[scopeId])).rows[0];
      if (!decision) throw conflict('Approved quotation decision is unavailable.');
      let quote: QuotationDocumentStored | null=null;
      if (decision.offer_document_id) {
        quote=(await tx.query<QuotationDocumentStored>('SELECT * FROM handyman_quotation_documents WHERE id=$1',[decision.offer_document_id])).rows[0] ?? null;
        if (!quote) throw integrity(); verifyStoredQuotationDocument(quote);
        if (quote.source_sha256!==decision.offer_source_sha256 || quote.pdf_sha256!==decision.offer_pdf_sha256 ||
            quote.quotation_version_id!==bast.source_snapshot.approvedQuotation.versionId || quote.client_id!==scope.clientId ||
            quote.source_snapshot.customer.buildingId!==scope.buildingId || quote.source_snapshot.customer.tenantCompanyId!==scope.tenantCompanyId) throw integrity();
      }
      const pins=bast.source_snapshot.manifest.snapshot.approvedVariations as VariationPin[];
      const variations: Source['variations']=[];
      const byVariation=new Map<string,VariationOfferStored>();
      for (const pin of pins) {
        const v=(await handymanScopeVariationRepository.listByExecutionScope(scopeId,tx)).find(x=>x.id===pin.id);
        if (!v || v.tenantDecisionOutcome!=='APPROVED' || !['AUTHORIZED_SCOPE','EXECUTION','QC','FINAL_CHARGE_ELIGIBILITY'].includes(v.status)) throw conflict('Manifest variation approval is no longer verifiable.');
        const events=await handymanScopeVariationRepository.listEventsByVariation(v.id,tx);
        if (!events.some(e=>e.id===pin.decisionEventId && e.eventType==='TENANT_DECISION') ||
            !events.some(e=>e.id===pin.authorizationEventId && e.eventType==='AUTHORIZED_SCOPE' && e.actorRole==='OPERATIONS_MANAGER')) throw integrity();
        await assertPinnedVariationApproval(tx,v,pin.approvedVersion,events);
        const offer=(await tx.query<VariationOfferStored>('SELECT * FROM handyman_variation_offer_documents WHERE variation_id=$1 AND execution_scope_id=$2',[v.id,scopeId])).rows[0];
        if (!offer) continue; // historical scope is not silently upgraded to warranty consent
        const revision=events.find(e=>e.eventType==='REVISED_QUOTATION' && e.actorRole==='OPERATIONS_MANAGER');
        const approved=events.find(e=>e.id===pin.decisionEventId);
        const ref=revision?.metadata.offerDocument as {id?:unknown;version?:unknown;sourceSha256?:unknown;pdfSha256?:unknown} | undefined;
        const consent=approved?.metadata.consentSnapshot as {offerDocumentId?:unknown;offerDocumentVersion?:unknown;offerPdfSha256?:unknown} | undefined;
        if (ref?.id!==offer.id || ref.version!==offer.variation_version || ref.sourceSha256!==offer.source_sha256 ||
            ref.pdfSha256!==offer.pdf_sha256 || consent?.offerDocumentId!==offer.id ||
            consent.offerDocumentVersion!==offer.variation_version || consent.offerPdfSha256!==offer.pdf_sha256) throw integrity();
        verifyStoredVariationOffer(offer);
        if (offer.client_id!==scope.clientId || offer.request_id!==scope.handymanRequestId || offer.variation_version!==pin.approvedVersion) throw integrity();
        byVariation.set(v.id,offer);
        variations.push({documentId:offer.id,variationId:v.id,number:offer.document_number,version:offer.variation_version,
          sourceSha256:offer.source_sha256,pdfSha256:offer.pdf_sha256,snapshot:offer.source_snapshot});
      }
      const edges=await readEdges(tx,scopeId);
      if (edges.some(e=>!pins.some(p=>p.id===e.variationId && p.decisionEventId===e.tenantDecisionEventId)))
        throw conflict('A consented warranty amendment is newer than the accepted completion manifest.');
      const items: Item[]=[];
      for (const item of bast.source_snapshot.manifest.snapshot.items) {
        if (!['COMPLETED','PARTIAL'].includes(item.status) || !/^(?:\d+)(?:\.\d+)?$/.test(item.actualQty) || !/[1-9]/.test(item.actualQty)) continue;
        const resolved=await resolveItem(tx,item,quote,bast,byVariation,edges,anchor.acceptedAt);
        if (resolved) items.push(resolved);
      }
      if (!items.length) throw conflict('No completed items have exact customer-agreed warranty terms with a valid contractual period.');
      await handymanDocumentIssuerProfileRepository.lockClientAuthority(tx,scope.clientId);
      await tx.query('SET LOCAL synchronous_commit=on');
      const durable=(await tx.query<{fsync:string;full_page_writes:string;sync_commit:string;replica:boolean}>(`SELECT current_setting('fsync') AS fsync,
        current_setting('full_page_writes') AS full_page_writes,current_setting('synchronous_commit') AS sync_commit,pg_is_in_recovery() AS replica`)).rows[0];
      if (durable?.fsync!=='on' || durable.full_page_writes!=='on' || durable.sync_commit!=='on' || durable.replica)
        throw new AppError({code:ERROR_CODES.HANDYMAN_WARRANTY_CERTIFICATE_DURABILITY_UNAVAILABLE,statusCode:503,message:'Warranty issuance requires durable primary PostgreSQL storage.'});
      const langs=(await tx.query<{language:HandymanDocumentLocale}>(`SELECT language FROM handyman_document_issuer_document_settings
        WHERE client_id=$1 AND document_kind='WARRANTY_CERTIFICATE' AND status='ACTIVE' ORDER BY language`,[scope.clientId])).rows;
      const language=languageInput ?? (langs.length===1 ? langs[0].language : undefined);
      if (!language) throw conflict('Select an active warranty certificate settings language.');
      const issuer=await resolveHandymanDocumentIssuerSnapshot(scope.clientId,tx);
      const settings=await resolveHandymanDocumentSettingsSnapshot(scope.clientId,'WARRANTY_CERTIFICATE',language,tx);
      for (const [table,id] of [['handyman_document_issuer_profiles',issuer.profileId],['handyman_document_issuer_document_settings',settings.settingsId]] as const) {
        if (!(await tx.query(`SELECT id FROM ${table} WHERE id=$1 AND status='ACTIVE' FOR SHARE`,[id])).rowCount) throw conflict('Warranty issuance settings changed.');
      }
      const allocation=(await tx.query<{number:string;issued_at:Date}>(`SELECT nextval('handyman_warranty_certificate_number_seq')::text AS number,clock_timestamp() AS issued_at`)).rows[0];
      const source:Source={ schema:'HANDYMAN_WARRANTY_CERTIFICATE_V1',status:'ISSUED',issuance:{id:randomUUID(),
        number:`${settings.documentPrefix}-${allocation.number.padStart(10,'0')}`,actorUserId:actor,issuedAt:allocation.issued_at.toISOString()},
        context:{clientId:scope.clientId,clientName:anchor.clientName,buildingId:scope.buildingId,buildingName:bast.source_snapshot.customer.buildingName,
          requestId:scope.handymanRequestId,tenantCompanyId:scope.tenantCompanyId,tenantName:bast.source_snapshot.customer.tenantName,
          tenantLegalName:bast.source_snapshot.customer.legalName,spaceId:bast.source_snapshot.customer.spaceId,executionScopeId:scopeId},
        warranty:{id:warrantyId},bast:{id:bastId,acceptedAt:anchor.acceptedAt,documentId:bast.id,number:bast.document_number,
          sourceSha256:bast.source_sha256,pdfSha256:bast.pdf_sha256,snapshot:bast.source_snapshot},manifest:bast.source_snapshot.manifest,
        approvedQuotation:bast.source_snapshot.approvedQuotation,
        quotation:quote ? {documentId:quote.id,number:quote.document_number,sourceSha256:quote.source_sha256,pdfSha256:quote.pdf_sha256,snapshot:quote.source_snapshot} : null,
        variations,edges,items,issuer,settings};
      const canonical=stableJson(source), digest=sha(canonical), pdf=await render(source,digest);
      if (pdf.bytes.length!==pdf.fileSize || pdf.fileSize<1 || pdf.fileSize>10485760 || sha(pdf.bytes)!==pdf.checksum || pdf.bytes.subarray(0,5).toString()!=='%PDF-') throw integrity();
      const stored=(await tx.query<Stored>(`INSERT INTO handyman_warranty_certificates
        (id,client_id,building_id,request_id,tenant_company_id,execution_scope_id,warranty_id,bast_id,bast_official_id,completion_verification_id,
         manifest_id,manifest_version,manifest_sha256,issuer_profile_id,settings_id,document_number,issued_by_user_id,issued_at,idempotency_key,
         source_snapshot,source_canonical,source_sha256,pdf_filename,pdf_bytes,pdf_size,pdf_sha256)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::text::jsonb,$20,$21,$22,$23,$24,$25) RETURNING *`,
      [source.issuance.id,scope.clientId,scope.buildingId,scope.handymanRequestId,scope.tenantCompanyId,scopeId,warrantyId,bastId,bast.id,
        completion.verificationId,manifestId,completion.manifestVersion,completion.manifestSha256,issuer.profileId,settings.settingsId,source.issuance.number,
        actor,source.issuance.issuedAt,key,canonical,digest,pdf.filename,pdf.bytes,pdf.fileSize,pdf.checksum])).rows[0];
      if (!stored) throw integrity();
      const d=verifyCertificate(stored); return {id:d.id,number:d.number,sourceChecksum:d.sourceChecksum,pdfChecksum:d.pdfChecksum,replayed:false};
    });
  } catch (error) {
    if (!(error instanceof AppError) && ['23505','23514','40001','40P01'].includes((error as {code?:string}).code ?? ''))
      throw conflict('Certificate issuance conflicted with a duplicate or changed source; reload and retry.');
    throw error;
  }
}

/** Follow only explicit consented replacements, never text matching or incidental
 * lines in a revised quote. Every predecessor snapshot must pin the authority
 * immediately before it in the chain. */
async function resolveItem(tx:PoolClient,item:ManifestItem,quote:QuotationDocumentStored|null,bast:OfficialBastStored,
  offers:Map<string,VariationOfferStored>,edges:Edge[],acceptedAt:string):Promise<Item|null> {
  const unit=bast.source_snapshot.units.find(u=>u.id===item.uomId);
  if (!unit?.symbol) throw integrity();
  let terms:WarrantyTerms|null=null, description='', chain:AgreementRef[]=[];
  if (item.variationId===null) {
    if (!quote || quote.source_snapshot.warrantyTermsProtocol!==QUOTATION_WARRANTY_PROTOCOL) return null;
    const line=quote.source_snapshot.lines.find(l=>l.id===item.quotationLineId);
    if (!line || quote.quotation_version_id!==item.quotationVersionId || line.description!==item.description ||
        line.lineType!==item.lineType || line.uomId!==item.uomId) throw integrity();
    terms=parseExactTerms(line.warrantyTerms); description=line.description;
    chain=[{kind:'QUOTATION',lineId:line.id,variationId:null,decisionId:bast.source_snapshot.approvedQuotation.decisionId,
      documentId:quote.id,number:quote.document_number,version:quote.source_snapshot.quotation.versionNumber,
      sourceSha256:quote.source_sha256,pdfSha256:quote.pdf_sha256}];
  } else {
    const offer=offers.get(item.variationId);
    if (!offer || offer.source_snapshot.warrantyTermsProtocol!==VARIATION_WARRANTY_PROTOCOL) return null;
    const change=offer.source_snapshot.warrantyChanges?.find(c=>c.kind==='ADD' && c.quotationLineId===item.quotationLineId);
    const line=offer.source_snapshot.revised.lines.find(l=>l.id===item.quotationLineId);
    const pin=(bast.source_snapshot.manifest.snapshot.approvedVariations as VariationPin[]).find(p=>p.id===item.variationId);
    if (!change || !line || !pin || offer.source_snapshot.variation.variationType!=='ADD' ||
        offer.source_snapshot.variation.revisedQuotationLineId!==item.quotationLineId ||
        offer.revised_quotation_version_id!==item.quotationVersionId || line.description!==item.description ||
        line.lineType!==item.lineType || line.uomId!==item.uomId || stableJson(change.warrantyTerms)!==stableJson(line.warrantyTerms)) throw integrity();
    terms=parseExactTerms(change.warrantyTerms); description=line.description;
    chain=[{kind:'ADD',lineId:line.id,variationId:item.variationId,decisionId:pin.decisionEventId,documentId:offer.id,
      number:offer.document_number,version:offer.variation_version,sourceSha256:offer.source_sha256,pdfSha256:offer.pdf_sha256}];
  }
  if (!terms) return null;
  const seen=new Set<string>();
  for (;;) {
    const previous=chain[chain.length-1];
    if (seen.has(previous.lineId)) throw integrity();
    seen.add(previous.lineId);
    const candidates=edges.filter(e=>e.predecessorLineId===previous.lineId);
    if (!candidates.length) break;
    if (candidates.length!==1) throw integrity();
    const edge=candidates[0], offer=offers.get(edge.variationId);
    const pin=(bast.source_snapshot.manifest.snapshot.approvedVariations as VariationPin[]).find(p=>p.id===edge.variationId);
    if (!offer || !pin || pin.decisionEventId!==edge.tenantDecisionEventId || offer.id!==edge.offerDocumentId ||
        offer.source_snapshot.warrantyTermsProtocol!==VARIATION_WARRANTY_PROTOCOL) throw conflict('Warranty amendment authority is incomplete.');
    const change=offer.source_snapshot.warrantyChanges?.find(c=>c.kind==='AMEND' && c.quotationLineId===edge.successorLineId && c.replacesQuotationLineId===edge.predecessorLineId);
    const predecessor=offer.source_snapshot.warrantyPredecessors?.find(p=>p.quotationLineId===edge.predecessorLineId);
    const line=offer.source_snapshot.revised.lines.find(l=>l.id===edge.successorLineId);
    if (!change || !predecessor || !line || line.replacesQuotationLineId!==edge.predecessorLineId ||
        stableJson(change.warrantyTerms)!==stableJson(line.warrantyTerms) || stableJson(predecessor.warrantyTerms)!==stableJson(terms) ||
        predecessor.description!==description || predecessor.authority!==(previous.kind==='QUOTATION'?'QUOTATION':'VARIATION') ||
        predecessor.decisionId!==previous.decisionId || predecessor.documentId!==previous.documentId ||
        predecessor.sourceSha256!==previous.sourceSha256 || predecessor.pdfSha256!==previous.pdfSha256) throw integrity();
    const next=parseExactTerms(change.warrantyTerms);
    if (!next) throw integrity();
    terms=next; description=line.description;
    chain.push({kind:'AMEND',lineId:line.id,variationId:edge.variationId,decisionId:pin.decisionEventId,
      documentId:offer.id,number:offer.document_number,version:offer.variation_version,sourceSha256:offer.source_sha256,pdfSha256:offer.pdf_sha256});
  }
  if (terms.coverage==='NONE') return null;
  const period=(await tx.query<{end:string;valid:boolean}>(`SELECT to_char(x.e AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "end", x.e>$1::timestamptz AS valid FROM
    (SELECT CASE WHEN $2='DURATION_DAYS' THEN $1::timestamptz + $3::integer * interval '24 hours'
      WHEN $2='FIXED_END_DATE_JAKARTA' THEN ($4::date+1)::timestamp AT TIME ZONE 'Asia/Jakarta' ELSE NULL END AS e) x`,
    [acceptedAt,terms.endRule,terms.durationDays,terms.fixedEndDate])).rows[0];
  if (!period?.valid || !period.end) return null; // invalid pre-acceptance fixed term cannot create coverage
  return {rootLineId:item.quotationLineId,quotationVersionId:item.quotationVersionId,variationId:item.variationId,
    description:item.description,lineType:item.lineType,actualQty:item.actualQty,unit:unit.symbol,terms,startsAt:acceptedAt,
    endsAtExclusive:period.end,agreementChain:chain};
}

/** No stale PDF may be delivered as current. The immutable row remains retained;
 * staff can retrieve it only through the explicitly historical archive path. */
async function assertCurrent(tx:Pick<PoolClient,'query'>,row:Stored):Promise<void> {
  const currentEdges=await readEdges(tx,row.execution_scope_id);
  const latest=(await tx.query<{id:string;version:number;source_sha256:string}>(`SELECT id,version,source_sha256 FROM handyman_completion_manifests
    WHERE execution_scope_id=$1 ORDER BY version DESC LIMIT 1`,[row.execution_scope_id])).rows[0];
  const variations=(await tx.query<{id:string}>(`SELECT id FROM handyman_scope_variations WHERE execution_scope_id=$1
    AND status IN ('AUTHORIZED_SCOPE','EXECUTION','QC','FINAL_CHARGE_ELIGIBILITY') ORDER BY id`,[row.execution_scope_id])).rows.map(r=>r.id);
  const pins=(row.source_snapshot.manifest.snapshot.approvedVariations as VariationPin[]).map(v=>v.id).sort();
  const snapshot=row.source_snapshot.manifest.snapshot;
  const sessionIds=(await tx.query<{id:string}>(`SELECT id FROM handyman_work_sessions WHERE execution_scope_id=$1 ORDER BY id`,[row.execution_scope_id])).rows.map(r=>r.id);
  const proofIds=(await tx.query<{id:string}>(`SELECT d.id FROM handyman_completion_declarations d LEFT JOIN handyman_completion_revocations r ON r.declaration_id=d.id
    WHERE d.execution_scope_id=$1 AND r.id IS NULL UNION ALL SELECT l.id FROM handyman_add_labor_executions l WHERE l.execution_scope_id=$1 ORDER BY id`,[row.execution_scope_id])).rows.map(r=>r.id);
  const frozenProofIds=snapshot.items.flatMap(i=>i.execution.map(e=>e.id)).sort();
  const frozenSessionIds=snapshot.sessions.map(s=>s.id).sort();
  const qc=(await tx.query(`SELECT 1 FROM handyman_completion_verifications v JOIN handyman_qc_runs q ON q.id=v.qc_run_id
    JOIN handyman_qc_run_events e ON e.id=v.qc_finish_event_id AND e.run_id=q.id AND e.event_type='FINISH' AND e.metadata->>'outcome'='PASSED'
    WHERE v.id=$1 AND v.execution_scope_id=$2 AND q.status='PASSED' AND q.version=v.qc_run_version`,[row.completion_verification_id,row.execution_scope_id])).rowCount;
  if (!latest || latest.id!==row.manifest_id || latest.version!==row.manifest_version || latest.source_sha256!==row.manifest_sha256 ||
      !qc || stableJson(sessionIds)!==stableJson(frozenSessionIds) || stableJson(proofIds)!==stableJson(frozenProofIds) ||
      stableJson(currentEdges)!==stableJson(row.source_snapshot.edges) || stableJson(variations)!==stableJson(pins))
    throw conflict('Certificate is historical: its accepted scope or agreed terms have changed. It must not be delivered as current.');
}

export async function downloadWarrantyCertificate(actorInput:string,scopeInput:string,certificateInput:string,historical=false) {
  const actor=uuid(actorInput,'actorUserId'),scope=uuid(scopeInput,'executionScopeId'),certificate=uuid(certificateInput,'certificateId');
  return withTransaction(async tx=>{
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const row=(await tx.query<Stored>('SELECT * FROM handyman_warranty_certificates WHERE id=$1 AND execution_scope_id=$2',[certificate,scope])).rows[0];
    if (!row) throw notFound();
    const user=(await tx.query<{status:string}>('SELECT status FROM users WHERE id=$1',[actor])).rows[0];
    const perms=await permissionRepository.listActivePermissionCodesForUser(actor,tx);
    if (user?.status!=='ACTIVE' || !perms.includes('handyman.care.building')) throw new AppError({code:ERROR_CODES.PERMISSION_DENIED,statusCode:403,message:'Active Building Care authority required.'});
    const buildings=await resolveBuildingsForUser(actor,tx);
    if (!buildings.some(b=>b.client?.id===row.client_id && b.building.id===row.building_id)) throw notFound();
    const document=verifyCertificate(row);
    if (!historical) await assertCurrent(tx,row);
    return document;
  });
}
export async function downloadWarrantyCertificateForCare(token:string,requestInput:unknown,certificateInput:unknown,query:unknown) {
  const principal=await resolveCareWorkspacePrincipal(token),selection=parseCareHandymanPaymentProofSelection(query);
  const requestId=uuid(requestInput,'requestId'),certificateId=uuid(certificateInput,'certificateId');
  return withTransaction(async tx=>{
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result=await tx.query<Stored & {authenticated:boolean}>(`${WORKSPACE_OCCUPANCY_CTES}
      SELECT EXISTS(SELECT 1 FROM authority) AS authenticated,d.* FROM (SELECT 1) singleton LEFT JOIN LATERAL (
        SELECT i.* FROM handyman_service_requests r
        JOIN records c ON c."clientId"=r.client_id AND c."tenantCompanyId"=r.tenant_company_id
          AND c."buildingId"=r.building_id AND c."spaceId" IS NOT DISTINCT FROM r.space_id
        JOIN handyman_execution_scopes s ON s.handyman_request_id=r.id AND s.client_id=r.client_id
          AND s.building_id=r.building_id AND s.tenant_company_id=r.tenant_company_id AND s.space_id IS NOT DISTINCT FROM r.space_id
        JOIN handyman_warranty_certificates i ON i.execution_scope_id=s.id AND i.client_id=r.client_id
          AND i.request_id=r.id AND i.building_id=r.building_id AND i.tenant_company_id=r.tenant_company_id
        WHERE $5::text IS NULL AND $6::integer=1 AND r.id=$10 AND i.id=$11
          AND r.tenant_company_id=$7 AND r.building_id=$8 AND r.space_id IS NOT DISTINCT FROM $9::uuid LIMIT 1
      ) d ON TRUE`,[principal.sessionId,principal.careActorId,principal.integrationId,selection.propertyId,null,1,
        selection.tenantCompanyId,selection.buildingId,selection.spaceId,requestId,certificateId]);
    const row=result.rows[0];
    if (!row?.authenticated) throw workspaceUnauthorized();
    if (!row.id) throw new AppError({code:ERROR_CODES.HANDYMAN_CARE_WORKSPACE_RESOURCE_NOT_FOUND,statusCode:404,message:'Care workspace resource not found.'});
    const document=verifyCertificate(row);
    await assertCurrent(tx,row);
    return document;
  });
}
