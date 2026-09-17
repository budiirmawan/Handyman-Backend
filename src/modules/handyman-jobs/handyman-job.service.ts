import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import {
  clientInactiveError,
  clientNotFoundError,
  clientRepository,
  type ClientRecord,
} from '../clients';
import { contextAccessService } from '../context-access';
import { buildingAccessDeniedError } from '../context-access/context-access.errors';
import { workforceNotExternalError } from '../external-workforce';
import {
  handymanProviderNotFoundError,
  handymanProviderRepository,
  handymanProviderStatusInvalidError,
  listHandymanProviderServiceEligibilities,
  listHandymanProviderServiceEligibilitiesPreauthorized,
} from '../handyman-providers';
import { handymanServiceSelectionRepository } from '../handyman-request-governance';
import {
  handymanQuotationApprovalRepository,
  handymanQuotationRepository,
  handymanQuotationRevisionNotFoundError,
  handymanQuotationRevisionRepository,
} from '../handyman-quotations';
import {
  handymanRequestNotFoundError,
  handymanRequestRepository,
} from '../handyman-requests';
import {
  handymanWorkCrewLeadRequiredError,
  handymanWorkCrewNotFoundError,
  handymanWorkCrewRepository,
  handymanWorkCrewStatusInvalidError,
  handymanWorkCrewWorkerBindingInactiveError,
  handymanWorkCrewWorkerProviderMismatchError,
} from '../handyman-work-crews';
import { recordOperationalEvent } from '../operational-events';
import {
  vendorAssignmentAlreadyActiveError,
  vendorAssignmentBuildingMismatchError,
  vendorAssignmentClientMismatchError,
} from '../vendor-assignments';
import { vendorBuildingRepository } from '../vendor-buildings';
import {
  vendorWorkforceBindingNotFoundError,
  vendorWorkforceClientMismatchError,
} from '../vendor-workforce';
import {
  createWorkOrder,
  toPublicWorkOrder,
  transitionWorkOrderStatus,
  workOrderNotFoundError,
  workOrderRepository,
  type PublicWorkOrder,
} from '../work-orders';
import {
  vendorInactiveError,
  vendorNotFoundError,
  vendorRepository,
} from '../vendors';
import { workforceProfileInactiveError } from '../workforce';
import {
  handymanJobAlreadyAssignedError,
  handymanJobAlreadyExistsError,
  handymanJobAssignmentStateInvalidError,
  handymanJobContextMismatchError,
  handymanJobCrewProviderMismatchError,
  handymanJobNotAssignableError,
  handymanJobNotAssignedError,
  handymanJobNotFoundError,
  handymanJobProviderClientMismatchError,
  handymanJobProviderServiceNotEligibleError,
  handymanJobQuotationNotApprovedError,
  handymanJobRequestNotApprovedError,
} from './handyman-job.errors';
import { handymanJobRepository } from './handyman-job.repository';
import type {
  AssignHandymanJobInput,
  CreateHandymanJobInput,
  HandymanJobAssignmentRecord,
  HandymanJobAssignmentResult,
  HandymanJobCreationResult,
  HandymanJobFilters,
  HandymanJobRecord,
  PublicHandymanJob,
  PublicHandymanJobAssignment,
} from './handyman-job.types';

/**
 * CR-HM-BE-05 RUN 1 — Handyman execution binding + assignment composition.
 *
 * Composes existing foundations; duplicates none of their rules:
 * - Execution lifecycle: the EXISTING BE-08 work order (created through the
 *   existing `createWorkOrder` authority; OPEN→ASSIGNED through the existing
 *   guarded `transitionWorkOrderStatus`). No second work-order lifecycle, no
 *   IN_PROGRESS/ON_HOLD/COMPLETED/CLOSED handling here, and the job row has
 *   NO status column.
 * - Commercial identity: the CR-HM-BE-03 request/quotation/revision/approval
 *   authorities, consumed READ-ONLY. The job binds the exact APPROVED
 *   quotation and its exact APPROVED sent revision (the composite FK makes a
 *   foreign revision structurally impossible).
 * - Provider operational assignment: the EXISTING BE-15A `vendor_assignments`
 *   table — no second assignment table. Execution context: the EXISTING
 *   BE-15B `vendor_works` row, resolved NOT_STARTED; this module never
 *   advances the vendor work lifecycle.
 * - Crew/person authority: the CR-HM-BE-04 crew aggregate + the BE-06F/03C
 *   worker chain (binding ACTIVE, EXTERNAL profile ACTIVE, same vendor and
 *   client), revalidated at TIME OF USE for the lead AND every ACTIVE
 *   member. No per-worker building eligibility is created. Deliberately NOT
 *   rejected in Run 1: a worker holding an ACTIVE membership in ANOTHER
 *   crew (no temporal worker-conflict model yet — carried to Run 2).
 *
 * Atomicity (CR-HM-BE-05 §6): the BE-15A/BE-15B SERVICES and repositories
 * accept no executor, so the composition cannot run inside their code. The
 * smallest safe composition that preserves every invariant is applied
 * instead: ONE `withTransaction` writes the BE-15A row, the BE-15B row, and
 * the composition row with the exact column semantics of the owning modules,
 * re-asserting every mutable fact under row locks (job FOR UPDATE, work
 * order FOR UPDATE, designation/vendor/crew FOR UPDATE, worker candidates
 * locked). Their structural constraints (`vendor_assignments_active_unique`,
 * `vendor_works_assignment_unique`, `handyman_job_assignments_one_active_per_
 * job`, `handyman_jobs_request_unique`) remain the shared final authority,
 * so a provider assignment can NEVER exist without its crew binding: any
 * failure rolls the whole composition back — zero compensation paths.
 *
 * Concurrency (no distributed locking): job creation serializes on the
 * deterministic work-order number `HMWO-<requestNumber>` (unique per client)
 * plus `handyman_jobs_request_unique`; a losing creator converges onto the
 * winner's job (idempotent replay). Assignment serializes on the locked job
 * row plus the one-ACTIVE partial unique index; reassignment additionally
 * uses a guarded `WHERE status = 'ACTIVE'` supersede so a stale command can
 * never overwrite newer state.
 *
 * Audit: `recordOperationalEvent` with IDs/status only — never customer,
 * tenant, or worker PII. The BE-15A/BE-15B parity events keep their exact
 * operational shapes (VENDOR_ASSIGNMENT_CREATED / VENDOR_ASSIGNMENT_
 * REASSIGNED / VENDOR_WORK_CREATED) so existing vendor-surface consumers see
 * one consistent event language.
 */

type Executor = Pick<PoolClient, 'query'>;

const UNIQUE_VIOLATION = '23505';
const JOBS_REQUEST_UNIQUE = 'handyman_jobs_request_unique';
const JOBS_WORK_ORDER_UNIQUE = 'handyman_jobs_work_order_unique';
const ASSIGNMENTS_ONE_ACTIVE = 'handyman_job_assignments_one_active_per_job';
const VENDOR_ASSIGNMENTS_ACTIVE_UNIQUE = 'vendor_assignments_active_unique';

/**
 * The Handyman pre-execution window. Assign/reassign are allowed only while
 * the work order is OPEN or ASSIGNED; IN_PROGRESS and beyond mean execution
 * has started (Run 1 never advances the BE-08 lifecycle itself, so this is
 * the only execution-start signal needed).
 */
const PRE_EXECUTION_WORK_ORDER_STATUSES: ReadonlySet<string> = new Set([
  'OPEN',
  'ASSIGNED',
]);

/** True while the work order is inside the pre-execution window (OPEN or
 * ASSIGNED). Exported for the CR-HM-BE-05 Run-2 scheduling/readiness gates. */
export function isPreExecutionWorkOrderStatus(status: string): boolean {
  return PRE_EXECUTION_WORK_ORDER_STATUSES.has(status);
}

export function toPublicHandymanJob(
  record: HandymanJobRecord,
): PublicHandymanJob {
  return {
    id: record.id,
    clientId: record.clientId,
    handymanRequestId: record.handymanRequestId,
    handymanQuotationId: record.handymanQuotationId,
    handymanQuotationRevisionId: record.handymanQuotationRevisionId,
    workOrderId: record.workOrderId,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function toPublicHandymanJobAssignment(
  record: HandymanJobAssignmentRecord,
): PublicHandymanJobAssignment {
  return {
    id: record.id,
    clientId: record.clientId,
    handymanJobId: record.handymanJobId,
    vendorAssignmentId: record.vendorAssignmentId,
    handymanWorkCrewId: record.handymanWorkCrewId,
    status: record.status,
    assignedAt: record.assignedAt.toISOString(),
    assignedByUserId: record.assignedByUserId,
    supersededAt: record.supersededAt ? record.supersededAt.toISOString() : null,
    supersededByUserId: record.supersededByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function uniqueViolationConstraint(error: unknown): string | null {
  if (
    !(error instanceof Error) ||
    (error as { code?: string }).code !== UNIQUE_VIOLATION
  ) {
    return null;
  }
  return (error as { constraint?: string }).constraint ?? null;
}

async function assertClientAccess(
  userId: string,
  clientId: string,
): Promise<void> {
  if (!(await contextAccessService.canAccessClient(userId, clientId))) {
    throw buildingAccessDeniedError();
  }
}

async function requireClient(clientId: string): Promise<ClientRecord> {
  const client = await clientRepository.findById(clientId);
  if (!client) {
    throw clientNotFoundError();
  }
  return client;
}

/* ------------------------------------------------------------------ */
/* Job creation                                                        */
/* ------------------------------------------------------------------ */

/**
 * Creates the thin execution binding for an APPROVED Handyman Request.
 *
 * Idempotent at the business-identity level: one job per request. A replay
 * (or a concurrent loser) converges onto the existing job without any
 * write. The work order is created through the EXISTING BE-08 authority with
 * the deterministic number `HMWO-<requestNumber>` — the request number
 * sequence (unique per client) is therefore reused as the cross-process
 * serialization point, and no second numbering convention is invented.
 */
export async function createHandymanJob(
  input: CreateHandymanJobInput,
  actorUserId: string,
): Promise<HandymanJobCreationResult> {
  // 1. Request existence, actor data scope, client status (BE-27A order).
  const request = await handymanRequestRepository.findById(
    input.handymanRequestId,
  );
  if (!request) {
    throw handymanRequestNotFoundError();
  }
  const client = await requireClient(request.clientId);
  await assertClientAccess(actorUserId, client.id);
  if (client.status !== 'ACTIVE') {
    throw clientInactiveError();
  }

  // 2. The request must be APPROVED (revalidated at time of use).
  if (request.status !== 'APPROVED') {
    throw handymanJobRequestNotApprovedError();
  }

  // 3. Business-identity idempotency: one job per request, no writes.
  const existingJob = await handymanJobRepository.findByRequestId(request.id);
  if (existingJob) {
    return { job: toPublicHandymanJob(existingJob), created: false };
  }

  // 4. The exact approved commercial binding (CR-HM-BE-03, read-only):
  //    APPROVED quotation → its sent revision → APPROVED approval decision.
  const quotations = await handymanQuotationRepository.listByRequest(
    request.id,
  );
  const quotation = quotations.find(
    (candidate) => candidate.status === 'APPROVED' && candidate.sentRevisionId,
  );
  if (!quotation || !quotation.sentRevisionId) {
    throw handymanJobQuotationNotApprovedError();
  }
  const approvals = await handymanQuotationApprovalRepository.listByRevision(
    quotation.sentRevisionId,
  );
  const approval = approvals.find(
    (candidate) =>
      candidate.status === 'APPROVED' &&
      candidate.quotationId === quotation.id,
  );
  if (!approval) {
    throw handymanJobQuotationNotApprovedError();
  }
  const revision = await handymanQuotationRevisionRepository.findById(
    quotation.sentRevisionId,
  );
  if (!revision || revision.quotationId !== quotation.id) {
    throw handymanQuotationRevisionNotFoundError();
  }

  // 5. Work order through the EXISTING authority. The number is derived,
  //    never caller-supplied; the collision path is the adoption path.
  const workOrderNumber = `HMWO-${request.requestNumber}`;
  let workOrder: PublicWorkOrder;
  try {
    workOrder = await createWorkOrder({
      clientId: request.clientId,
      buildingId: request.buildingId,
      workOrderNumber,
      title: `Handyman job ${request.requestNumber}`,
      workType: 'HANDYMAN',
      createdByUserId: actorUserId,
    });
  } catch (error) {
    if (
      !(error instanceof AppError) ||
      error.code !== ERROR_CODES.WORK_ORDER_NUMBER_ALREADY_EXISTS
    ) {
      throw error;
    }
    // A creator already produced this work order (crash window or race).
    const existingWo = await workOrderRepository.findByWorkOrderNumberForClient(
      request.clientId,
      workOrderNumber,
    );
    if (!existingWo) {
      throw error;
    }
    const boundJob = await handymanJobRepository.findByWorkOrderId(
      existingWo.id,
    );
    if (boundJob) {
      if (boundJob.handymanRequestId !== request.id) {
        throw handymanJobAlreadyExistsError(
          'The derived work order number is bound to a different handyman request.',
        );
      }
      return { job: toPublicHandymanJob(boundJob), created: false };
    }
    if (existingWo.workType !== 'HANDYMAN') {
      throw handymanJobAlreadyExistsError(
        'The derived work order number collides with a non-handyman work order.',
      );
    }
    if (
      existingWo.clientId !== request.clientId ||
      existingWo.buildingId !== request.buildingId
    ) {
      throw handymanJobContextMismatchError();
    }
    workOrder = toPublicWorkOrder(existingWo);
  }

  // 6. Bind the job. The UNIQUE constraints are the final concurrency
  //    authority; a loser reloads and returns the winner's job.
  let job: HandymanJobRecord;
  try {
    job = await handymanJobRepository.create({
      clientId: request.clientId,
      handymanRequestId: request.id,
      handymanQuotationId: quotation.id,
      handymanQuotationRevisionId: revision.id,
      workOrderId: workOrder.id,
      createdByUserId: actorUserId,
    });
  } catch (error) {
    const constraint = uniqueViolationConstraint(error);
    if (constraint === JOBS_REQUEST_UNIQUE) {
      const winner = await handymanJobRepository.findByRequestId(request.id);
      if (winner) {
        return { job: toPublicHandymanJob(winner), created: false };
      }
    } else if (constraint === JOBS_WORK_ORDER_UNIQUE) {
      const winner = await handymanJobRepository.findByWorkOrderId(
        workOrder.id,
      );
      if (winner && winner.handymanRequestId === request.id) {
        return { job: toPublicHandymanJob(winner), created: false };
      }
    }
    if (constraint) {
      throw handymanJobAlreadyExistsError();
    }
    throw error;
  }

  await recordOperationalEvent({
    clientId: job.clientId,
    eventType: 'HANDYMAN_JOB_CREATED',
    entityType: 'HANDYMAN_JOB',
    entityId: job.id,
    actorUserId,
    buildingId: request.buildingId,
    summary: `Handyman job created for work order ${workOrder.workOrderNumber}`,
    metadata: {
      handymanRequestId: request.id,
      handymanQuotationId: quotation.id,
      handymanQuotationRevisionId: revision.id,
      workOrderId: workOrder.id,
    },
  });

  return { job: toPublicHandymanJob(job), created: true };
}

/* ------------------------------------------------------------------ */
/* Assignment composition — shared helpers                             */
/* ------------------------------------------------------------------ */

export type JobContext = {
  job: HandymanJobRecord;
  request: { id: string; clientId: string; buildingId: string };
  workOrder: PublicWorkOrder;
};

/** Loads the job with its client-scope gate and structural context checks. */
export async function loadJobContext(
  jobId: string,
  actorUserId: string,
): Promise<JobContext> {
  const job = await handymanJobRepository.findById(jobId);
  if (!job) {
    throw handymanJobNotFoundError();
  }
  const client = await requireClient(job.clientId);
  await assertClientAccess(actorUserId, client.id);
  if (client.status !== 'ACTIVE') {
    throw clientInactiveError();
  }
  const request = await handymanRequestRepository.findById(
    job.handymanRequestId,
  );
  if (!request) {
    throw handymanRequestNotFoundError();
  }
  const workOrderRecord = await workOrderRepository.findById(job.workOrderId);
  if (!workOrderRecord) {
    throw workOrderNotFoundError();
  }
  if (
    request.clientId !== job.clientId ||
    workOrderRecord.clientId !== job.clientId ||
    workOrderRecord.buildingId !== request.buildingId
  ) {
    throw handymanJobContextMismatchError();
  }
  return { job, request, workOrder: toPublicWorkOrder(workOrderRecord) };
}

export function assertPreExecutionWorkOrder(status: string): void {
  if (!PRE_EXECUTION_WORK_ORDER_STATUSES.has(status)) {
    throw handymanJobNotAssignableError(
      `Work order status ${status} is past the pre-execution assignment window.`,
    );
  }
}

/**
 * Provider chain, revalidated at time of use through the owning authorities:
 * designation (CR-HM-BE-02) ACTIVE + client match → vendor (BE-06A) ACTIVE +
 * client match (BE-15A parity) → ACTIVE vendor↔building relationship for the
 * work order's building (BE-06D, BE-15A parity) → EVERY ACTIVE governed
 * request service covered by the provider's service eligibility at that
 * building (BE-06E via CR-HM-BE-02). Failures reuse the owning modules'
 * errors; only the Handyman-specific rules get BE-05 codes.
 */
export async function requireEligibleProviderForJob(
  context: JobContext,
  handymanProviderId: string,
  actorUserId: string,
): Promise<{ providerId: string; vendorId: string }> {
  return requireEligibleProviderForJobWith(context, handymanProviderId, (buildingId, providerId) =>
    listHandymanProviderServiceEligibilities(buildingId, providerId, actorUserId),
  );
}

/**
 * Access-neutral variant for governed preauthorized command chains
 * (CR-HM-BE-06 Run 2 §11): the IDENTICAL provider-chain rule body as
 * {@link requireEligibleProviderForJob} — same designation/vendor/
 * relationship revalidation and same capability-coverage requirement —
 * consuming the BE-02 preauthorized eligibility read instead of the
 * actor-gated one. Callers MUST have independently authorized the actor
 * for this exact job/visit (the Handyman Work Session start command proves
 * field authority through the BE-06 lead chain).
 */
export async function requireEligibleProviderForJobPreauthorized(
  context: JobContext,
  handymanProviderId: string,
): Promise<{ providerId: string; vendorId: string }> {
  return requireEligibleProviderForJobWith(
    context,
    handymanProviderId,
    (buildingId, providerId) =>
      listHandymanProviderServiceEligibilitiesPreauthorized(
        buildingId,
        providerId,
      ),
  );
}

async function requireEligibleProviderForJobWith(
  context: JobContext,
  handymanProviderId: string,
  listEligibilities: (
    buildingId: string,
    providerId: string,
  ) => Promise<{ serviceCatalogId: string }[]>,
): Promise<{ providerId: string; vendorId: string }> {
  const provider = await handymanProviderRepository.findById(
    handymanProviderId,
  );
  if (!provider) {
    throw handymanProviderNotFoundError();
  }
  if (provider.clientId !== context.job.clientId) {
    throw handymanJobProviderClientMismatchError();
  }
  if (provider.status !== 'ACTIVE') {
    throw handymanProviderStatusInvalidError(
      'The handyman provider designation is not active.',
    );
  }
  const vendor = await vendorRepository.findById(provider.vendorId);
  if (!vendor) {
    throw vendorNotFoundError();
  }
  if (vendor.status !== 'ACTIVE') {
    throw vendorInactiveError();
  }
  if (vendor.clientId !== context.workOrder.clientId) {
    throw vendorAssignmentClientMismatchError();
  }
  const relationship = await vendorBuildingRepository.findActiveByVendorAndBuilding(
    vendor.id,
    context.workOrder.buildingId,
  );
  if (!relationship) {
    throw vendorAssignmentBuildingMismatchError();
  }

  const services = await handymanServiceSelectionRepository.listByRequest(
    context.request.id,
    { status: 'ACTIVE' },
  );
  const eligibilities = await listEligibilities(
    context.workOrder.buildingId,
    provider.id,
  );
  const eligibleServiceIds = new Set(
    eligibilities.map((eligibility) => eligibility.serviceCatalogId),
  );
  const missing = services.filter(
    (service) => !eligibleServiceIds.has(service.serviceCatalogId),
  );
  if (missing.length > 0) {
    throw handymanJobProviderServiceNotEligibleError(missing.length);
  }
  return { providerId: provider.id, vendorId: vendor.id };
}

/**
 * One worker through the EXISTING personnel authority only (CR-HM-BE-04 §3
 * chain, reused verbatim with the owning modules' errors): binding ACTIVE →
 * binding belongs to the provider's vendor → profile ACTIVE → profile
 * EXTERNAL → profile resolves to the job's client.
 *
 * Deliberately NOT checked (CR-HM-BE-05 Run 1): whether this worker also
 * holds an ACTIVE membership in ANOTHER crew. Run 1 has no temporal
 * worker-conflict model; cross-crew membership is accepted (carried to
 * Run 2). No CR-HM-BE-04 rule is modified.
 */
async function requireValidJobCrewWorker(
  vendorWorkforceBindingId: string,
  clientId: string,
  providerVendorId: string,
  executor: Executor,
): Promise<void> {
  const candidate = await handymanWorkCrewRepository.lockWorkerCandidate(
    vendorWorkforceBindingId,
    executor,
  );
  if (!candidate) {
    throw vendorWorkforceBindingNotFoundError();
  }
  if (candidate.bindingStatus !== 'ACTIVE') {
    throw handymanWorkCrewWorkerBindingInactiveError();
  }
  if (candidate.vendorId !== providerVendorId) {
    throw handymanWorkCrewWorkerProviderMismatchError();
  }
  if (candidate.profileStatus !== 'ACTIVE') {
    throw workforceProfileInactiveError();
  }
  if (candidate.workforceType !== 'EXTERNAL') {
    throw workforceNotExternalError();
  }
  if (candidate.profileClientId !== clientId) {
    throw vendorWorkforceClientMismatchError();
  }
}

/**
 * Crew chain at time of use: crew exists + ACTIVE + belongs to the selected
 * provider, has a valid ACTIVE lead (CR-HM-BE-04 aggregate invariant), and
 * EVERY ACTIVE member (lead included) passes the worker chain. `lock` runs
 * the crew row FOR UPDATE inside the composition transaction.
 *
 * Members are validated in ASCENDING vendor workforce binding id order: the
 * per-worker `lockWorkerCandidate` locks exactly the binding row
 * (`FOR UPDATE OF b`), so a sorted acquisition order is the deterministic
 * lock ordering that keeps concurrent commands sharing workers deadlock-free
 * (CR-HM-BE-05 Run 2 §7). Returns the sorted ACTIVE binding ids for the
 * temporal worker-conflict scan.
 */
export async function requireOperationalCrewChain(
  handymanWorkCrewId: string,
  providerId: string,
  providerVendorId: string,
  clientId: string,
  executor: Executor,
  lock: boolean,
): Promise<string[]> {
  const crew = lock
    ? await handymanWorkCrewRepository.lockById(handymanWorkCrewId, executor)
    : await handymanWorkCrewRepository.findById(handymanWorkCrewId, executor);
  if (!crew) {
    throw handymanWorkCrewNotFoundError();
  }
  if (crew.status !== 'ACTIVE') {
    throw handymanWorkCrewStatusInvalidError(
      'The handyman work crew is not active.',
    );
  }
  if (crew.handymanProviderId !== providerId) {
    throw handymanJobCrewProviderMismatchError();
  }
  const lead = await handymanWorkCrewRepository.findActiveLead(
    handymanWorkCrewId,
    executor,
  );
  if (!lead) {
    throw handymanWorkCrewLeadRequiredError();
  }
  const members = await handymanWorkCrewRepository.listMembers(
    handymanWorkCrewId,
    { status: 'ACTIVE' },
    executor,
  );
  const sortedMembers = [...members].sort((a, b) =>
    a.vendorWorkforceBindingId.localeCompare(b.vendorWorkforceBindingId),
  );
  for (const member of sortedMembers) {
    await requireValidJobCrewWorker(
      member.vendorWorkforceBindingId,
      clientId,
      providerVendorId,
      executor,
    );
  }
  return sortedMembers.map((member) => member.vendorWorkforceBindingId);
}

/**
 * Post-commit convergence seam: OPEN→ASSIGNED through the EXISTING guarded
 * transition (never a direct write). If a concurrent external flow moved the
 * work order first, the guarded transition fails; the work order is then
 * already past OPEN under its own lifecycle authority, which this module
 * accepts (Run 1 owns no execution lifecycle). A still-OPEN work order after
 * a failed transition is impossible (OPEN→ASSIGNED is legal) and rethrows.
 */
async function convergeWorkOrderToAssigned(
  workOrderId: string,
): Promise<string> {
  try {
    const updated = await transitionWorkOrderStatus(workOrderId, {
      status: 'ASSIGNED',
    });
    return updated.status;
  } catch (error) {
    if (
      error instanceof AppError &&
      error.code === ERROR_CODES.WORK_ORDER_INVALID_TRANSITION
    ) {
      const current = await workOrderRepository.findById(workOrderId);
      if (current && current.status !== 'OPEN') {
        return current.status;
      }
    }
    throw error;
  }
}

/** Resolves the target designation to its vendor WITHOUT status assertions —
 * used only for idempotent-replay identity comparison. */
async function resolveTargetVendorId(
  handymanProviderId: string,
): Promise<string | null> {
  const provider = await handymanProviderRepository.findById(
    handymanProviderId,
  );
  return provider ? provider.vendorId : null;
}

/* ------------------------------------------------------------------ */
/* The ONE governed assignment command                                 */
/* ------------------------------------------------------------------ */

/**
 * Assigns provider + crew to a Handyman job as ONE governed composition:
 * BE-15A vendor assignment + BE-15B NOT_STARTED vendor work + the ACTIVE
 * composition row, atomically. Business identity only — the caller never
 * supplies a vendor_assignment_id.
 */
export async function assignHandymanJobProviderAndCrew(
  jobId: string,
  input: AssignHandymanJobInput,
  actorUserId: string,
): Promise<HandymanJobAssignmentResult> {
  const context = await loadJobContext(jobId, actorUserId);
  const { job, request, workOrder } = context;

  // Idempotent replay: an ACTIVE composition with the SAME target returns as
  //-is (and converges the OPEN→ASSIGNED seam if a crash left it pending).
  const existing = await handymanJobRepository.findActiveByJobId(job.id);
  if (existing) {
    const existingVendorAssignment =
      await handymanJobRepository.findVendorAssignmentById(
        existing.vendorAssignmentId,
      );
    const targetVendorId = await resolveTargetVendorId(
      input.handymanProviderId,
    );
    if (
      existingVendorAssignment &&
      targetVendorId !== null &&
      existingVendorAssignment.vendorId === targetVendorId &&
      existing.handymanWorkCrewId === input.handymanWorkCrewId
    ) {
      const workOrderStatus =
        workOrder.status === 'OPEN'
          ? await convergeWorkOrderToAssigned(workOrder.id)
          : workOrder.status;
      const existingWork =
        await handymanJobRepository.findVendorWorkByAssignmentId(
          existing.vendorAssignmentId,
        );
      return {
        job: toPublicHandymanJob(job),
        assignment: toPublicHandymanJobAssignment(existing),
        vendorAssignmentId: existing.vendorAssignmentId,
        vendorWorkId: existingWork ? existingWork.id : '',
        workOrderStatus,
      };
    }
    throw handymanJobAlreadyAssignedError();
  }

  // Pre-execution gate + full time-of-use validation of both chains.
  assertPreExecutionWorkOrder(workOrder.status);
  const provider = await requireEligibleProviderForJob(
    context,
    input.handymanProviderId,
    actorUserId,
  );
  await requireOperationalCrewChain(
    input.handymanWorkCrewId,
    provider.providerId,
    provider.vendorId,
    job.clientId,
    getPool(),
    false,
  );

  // ONE composition transaction (see module header for the atomicity
  // doctrine): every mutable fact is re-asserted under row locks, then the
  // BE-15A row, BE-15B row, composition row, and parity events are written
  // together — all or nothing.
  const composed = await withTransaction(async (tx) => {
    const lockedJob = await handymanJobRepository.lockById(job.id, tx);
    if (!lockedJob) {
      throw handymanJobNotFoundError();
    }
    const lockedWorkOrder =
      await handymanJobRepository.lockWorkOrderForComposition(
        lockedJob.workOrderId,
        tx,
      );
    if (!lockedWorkOrder) {
      throw workOrderNotFoundError();
    }
    assertPreExecutionWorkOrder(lockedWorkOrder.status);
    const racing = await handymanJobRepository.findActiveByJobId(
      lockedJob.id,
      tx,
    );
    if (racing) {
      throw handymanJobAlreadyAssignedError();
    }

    const designation = await handymanJobRepository.lockProviderDesignation(
      provider.providerId,
      tx,
    );
    if (!designation) {
      throw handymanProviderNotFoundError();
    }
    if (designation.clientId !== lockedJob.clientId) {
      throw handymanJobProviderClientMismatchError();
    }
    if (designation.status !== 'ACTIVE' || designation.vendorId !== provider.vendorId) {
      throw handymanProviderStatusInvalidError(
        'The handyman provider designation is no longer assignable.',
      );
    }
    const lockedVendor = await handymanJobRepository.lockVendor(
      provider.vendorId,
      tx,
    );
    if (!lockedVendor) {
      throw vendorNotFoundError();
    }
    if (lockedVendor.status !== 'ACTIVE') {
      throw vendorInactiveError();
    }
    if (lockedVendor.clientId !== lockedWorkOrder.clientId) {
      throw vendorAssignmentClientMismatchError();
    }
    const relationship =
      await handymanJobRepository.findActiveVendorBuildingRelationship(
        provider.vendorId,
        lockedWorkOrder.buildingId,
        tx,
      );
    if (!relationship) {
      throw vendorAssignmentBuildingMismatchError();
    }
    await requireOperationalCrewChain(
      input.handymanWorkCrewId,
      provider.providerId,
      provider.vendorId,
      lockedJob.clientId,
      tx,
      true,
    );

    // BE-15A row (exact column semantics; partial unique stays the final
    // authority for same-vendor races).
    let vendorAssignment;
    try {
      vendorAssignment = await handymanJobRepository.createVendorAssignment(
        {
          vendorId: provider.vendorId,
          workOrderId: lockedWorkOrder.id,
          buildingId: lockedWorkOrder.buildingId,
          assignedByUserId: actorUserId,
        },
        tx,
      );
    } catch (error) {
      if (
        uniqueViolationConstraint(error) === VENDOR_ASSIGNMENTS_ACTIVE_UNIQUE
      ) {
        throw vendorAssignmentAlreadyActiveError();
      }
      throw error;
    }

    // BE-15B row: NOT_STARTED via the table default — the lifecycle is never
    // advanced here.
    const vendorWork = await handymanJobRepository.createVendorWork(
      {
        vendorAssignmentId: vendorAssignment.id,
        vendorId: provider.vendorId,
        workOrderId: lockedWorkOrder.id,
        buildingId: lockedWorkOrder.buildingId,
      },
      tx,
    );

    // Composition row: one ACTIVE per job (partial unique = final authority).
    let composition;
    try {
      composition = await handymanJobRepository.createAssignment(
        {
          clientId: lockedJob.clientId,
          handymanJobId: lockedJob.id,
          vendorAssignmentId: vendorAssignment.id,
          handymanWorkCrewId: input.handymanWorkCrewId,
          assignedByUserId: actorUserId,
        },
        tx,
      );
    } catch (error) {
      if (uniqueViolationConstraint(error) === ASSIGNMENTS_ONE_ACTIVE) {
        // A concurrent winner committed first; this transaction rolls back
        // completely — no orphan vendor assignment or vendor work survives.
        throw handymanJobAlreadyAssignedError();
      }
      throw error;
    }

    await recordOperationalEvent(
      {
        clientId: lockedJob.clientId,
        eventType: 'VENDOR_ASSIGNMENT_CREATED',
        entityType: 'VENDOR_ASSIGNMENT',
        entityId: vendorAssignment.id,
        actorUserId,
        buildingId: lockedWorkOrder.buildingId,
        summary: 'Vendor assigned to work order',
        metadata: {
          vendorId: vendorAssignment.vendorId,
          workOrderId: vendorAssignment.workOrderId,
          vendorAssignmentId: vendorAssignment.id,
        },
      },
      tx,
    );
    await recordOperationalEvent(
      {
        clientId: lockedJob.clientId,
        eventType: 'VENDOR_WORK_CREATED',
        entityType: 'VENDOR_WORK',
        entityId: vendorWork.id,
        actorUserId,
        buildingId: lockedWorkOrder.buildingId,
        vendorWorkId: vendorWork.id,
        summary: 'Vendor work created',
        metadata: {
          vendorId: provider.vendorId,
          workOrderId: lockedWorkOrder.id,
          vendorAssignmentId: vendorAssignment.id,
        },
      },
      tx,
    );
    await recordOperationalEvent(
      {
        clientId: lockedJob.clientId,
        eventType: 'HANDYMAN_JOB_ASSIGNED',
        entityType: 'HANDYMAN_JOB',
        entityId: lockedJob.id,
        actorUserId,
        buildingId: lockedWorkOrder.buildingId,
        vendorWorkId: vendorWork.id,
        summary: 'Handyman job provider and crew assigned',
        metadata: {
          handymanJobAssignmentId: composition.id,
          vendorAssignmentId: vendorAssignment.id,
          vendorWorkId: vendorWork.id,
          handymanProviderId: provider.providerId,
          vendorId: provider.vendorId,
          handymanWorkCrewId: input.handymanWorkCrewId,
        },
      },
      tx,
    );

    return {
      composition,
      vendorAssignmentId: vendorAssignment.id,
      vendorWorkId: vendorWork.id,
      workOrderStatusAtCommit: lockedWorkOrder.status,
    };
  });

  const workOrderStatus =
    composed.workOrderStatusAtCommit === 'OPEN'
      ? await convergeWorkOrderToAssigned(job.workOrderId)
      : composed.workOrderStatusAtCommit;

  return {
    job: toPublicHandymanJob(job),
    assignment: toPublicHandymanJobAssignment(composed.composition),
    vendorAssignmentId: composed.vendorAssignmentId,
    vendorWorkId: composed.vendorWorkId,
    workOrderStatus,
  };
}

/* ------------------------------------------------------------------ */
/* Reassignment (pre-execution only, history preserved)                */
/* ------------------------------------------------------------------ */

/**
 * Reassigns provider + crew before execution starts. The old composition is
 * SUPERSEDED with attribution (never deleted, never rewritten); the old
 * BE-15A assignment is deactivated (BE-15A semantics); the old BE-15B vendor
 * work row is retained untouched as history. The new composition is written
 * in the SAME transaction — there is never a window without exactly one
 * ACTIVE composition, and never a provider assignment without a crew.
 */
export async function reassignHandymanJobProviderAndCrew(
  jobId: string,
  input: AssignHandymanJobInput,
  actorUserId: string,
): Promise<HandymanJobAssignmentResult> {
  const context = await loadJobContext(jobId, actorUserId);
  const { job, workOrder } = context;

  const current = await handymanJobRepository.findActiveByJobId(job.id);
  if (!current) {
    throw handymanJobNotAssignedError();
  }

  // Idempotent replay of the SAME target: return the current composition
  // (and converge the OPEN→ASSIGNED seam if one is still pending).
  const currentVendorAssignment =
    await handymanJobRepository.findVendorAssignmentById(
      current.vendorAssignmentId,
    );
  const targetVendorId = await resolveTargetVendorId(input.handymanProviderId);
  if (
    currentVendorAssignment &&
    targetVendorId !== null &&
    currentVendorAssignment.vendorId === targetVendorId &&
    current.handymanWorkCrewId === input.handymanWorkCrewId
  ) {
    const workOrderStatus =
      workOrder.status === 'OPEN'
        ? await convergeWorkOrderToAssigned(workOrder.id)
        : workOrder.status;
    const currentWork = await handymanJobRepository.findVendorWorkByAssignmentId(
      current.vendorAssignmentId,
    );
    return {
      job: toPublicHandymanJob(job),
      assignment: toPublicHandymanJobAssignment(current),
      vendorAssignmentId: current.vendorAssignmentId,
      vendorWorkId: currentWork ? currentWork.id : '',
      workOrderStatus,
    };
  }

  // Execution gates: the work order must be pre-execution AND the current
  // vendor work must still be NOT_STARTED (BE-15B lifecycle untouched).
  assertPreExecutionWorkOrder(workOrder.status);
  const currentWork = await handymanJobRepository.findVendorWorkByAssignmentId(
    current.vendorAssignmentId,
  );
  if (currentWork && currentWork.status !== 'NOT_STARTED') {
    throw handymanJobNotAssignableError(
      'Execution has already started for the current assignment.',
    );
  }

  const provider = await requireEligibleProviderForJob(
    context,
    input.handymanProviderId,
    actorUserId,
  );
  await requireOperationalCrewChain(
    input.handymanWorkCrewId,
    provider.providerId,
    provider.vendorId,
    job.clientId,
    getPool(),
    false,
  );

  const composed = await withTransaction(async (tx) => {
    const lockedJob = await handymanJobRepository.lockById(job.id, tx);
    if (!lockedJob) {
      throw handymanJobNotFoundError();
    }
    const lockedWorkOrder =
      await handymanJobRepository.lockWorkOrderForComposition(
        lockedJob.workOrderId,
        tx,
      );
    if (!lockedWorkOrder) {
      throw workOrderNotFoundError();
    }
    assertPreExecutionWorkOrder(lockedWorkOrder.status);

    // The command must still target the composition it validated against:
    // a concurrent reassignment makes this one stale (409, never overwrite).
    const currentInTx = await handymanJobRepository.findActiveByJobId(
      lockedJob.id,
      tx,
    );
    if (!currentInTx) {
      throw handymanJobNotAssignedError();
    }
    if (currentInTx.id !== current.id) {
      throw handymanJobAssignmentStateInvalidError();
    }
    const lockedWork = await handymanJobRepository.findVendorWorkByAssignmentId(
      current.vendorAssignmentId,
      tx,
    );
    if (lockedWork && lockedWork.status !== 'NOT_STARTED') {
      throw handymanJobNotAssignableError(
        'Execution has already started for the current assignment.',
      );
    }

    // Guarded supersede: WHERE status = 'ACTIVE' — a stale command cannot
    // rewrite history.
    const superseded = await handymanJobRepository.supersedeActiveAssignment(
      current.id,
      actorUserId,
      tx,
    );
    if (!superseded) {
      throw handymanJobAssignmentStateInvalidError();
    }
    // BE-15A deactivation of the old assignment (never a delete). Zero rows
    // is tolerated: the composition may repair a vendor assignment already
    // deactivated through the BM surface.
    await handymanJobRepository.deactivateVendorAssignmentIfActive(
      current.vendorAssignmentId,
      tx,
    );

    const designation = await handymanJobRepository.lockProviderDesignation(
      provider.providerId,
      tx,
    );
    if (!designation) {
      throw handymanProviderNotFoundError();
    }
    if (designation.clientId !== lockedJob.clientId) {
      throw handymanJobProviderClientMismatchError();
    }
    if (designation.status !== 'ACTIVE' || designation.vendorId !== provider.vendorId) {
      throw handymanProviderStatusInvalidError(
        'The handyman provider designation is no longer assignable.',
      );
    }
    const lockedVendor = await handymanJobRepository.lockVendor(
      provider.vendorId,
      tx,
    );
    if (!lockedVendor) {
      throw vendorNotFoundError();
    }
    if (lockedVendor.status !== 'ACTIVE') {
      throw vendorInactiveError();
    }
    if (lockedVendor.clientId !== lockedWorkOrder.clientId) {
      throw vendorAssignmentClientMismatchError();
    }
    const relationship =
      await handymanJobRepository.findActiveVendorBuildingRelationship(
        provider.vendorId,
        lockedWorkOrder.buildingId,
        tx,
      );
    if (!relationship) {
      throw vendorAssignmentBuildingMismatchError();
    }
    await requireOperationalCrewChain(
      input.handymanWorkCrewId,
      provider.providerId,
      provider.vendorId,
      lockedJob.clientId,
      tx,
      true,
    );

    // The old assignment was just deactivated IN THIS transaction, so the
    // same-vendor reassignment satisfies vendor_assignments_active_unique
    // exactly like the BE-15A reassignment ordering does — atomically.
    let vendorAssignment;
    try {
      vendorAssignment = await handymanJobRepository.createVendorAssignment(
        {
          vendorId: provider.vendorId,
          workOrderId: lockedWorkOrder.id,
          buildingId: lockedWorkOrder.buildingId,
          assignedByUserId: actorUserId,
        },
        tx,
      );
    } catch (error) {
      if (
        uniqueViolationConstraint(error) === VENDOR_ASSIGNMENTS_ACTIVE_UNIQUE
      ) {
        throw vendorAssignmentAlreadyActiveError();
      }
      throw error;
    }
    const vendorWork = await handymanJobRepository.createVendorWork(
      {
        vendorAssignmentId: vendorAssignment.id,
        vendorId: provider.vendorId,
        workOrderId: lockedWorkOrder.id,
        buildingId: lockedWorkOrder.buildingId,
      },
      tx,
    );
    let composition;
    try {
      composition = await handymanJobRepository.createAssignment(
        {
          clientId: lockedJob.clientId,
          handymanJobId: lockedJob.id,
          vendorAssignmentId: vendorAssignment.id,
          handymanWorkCrewId: input.handymanWorkCrewId,
          assignedByUserId: actorUserId,
        },
        tx,
      );
    } catch (error) {
      if (uniqueViolationConstraint(error) === ASSIGNMENTS_ONE_ACTIVE) {
        throw handymanJobAssignmentStateInvalidError();
      }
      throw error;
    }

    await recordOperationalEvent(
      {
        clientId: lockedJob.clientId,
        eventType: 'VENDOR_ASSIGNMENT_REASSIGNED',
        entityType: 'VENDOR_ASSIGNMENT',
        entityId: vendorAssignment.id,
        actorUserId,
        buildingId: lockedWorkOrder.buildingId,
        summary: 'Vendor assignment reassigned',
        metadata: {
          vendorId: vendorAssignment.vendorId,
          workOrderId: vendorAssignment.workOrderId,
          vendorAssignmentId: vendorAssignment.id,
          previousAssignmentId: current.vendorAssignmentId,
        },
      },
      tx,
    );
    await recordOperationalEvent(
      {
        clientId: lockedJob.clientId,
        eventType: 'VENDOR_WORK_CREATED',
        entityType: 'VENDOR_WORK',
        entityId: vendorWork.id,
        actorUserId,
        buildingId: lockedWorkOrder.buildingId,
        vendorWorkId: vendorWork.id,
        summary: 'Vendor work created',
        metadata: {
          vendorId: provider.vendorId,
          workOrderId: lockedWorkOrder.id,
          vendorAssignmentId: vendorAssignment.id,
        },
      },
      tx,
    );
    await recordOperationalEvent(
      {
        clientId: lockedJob.clientId,
        eventType: 'HANDYMAN_JOB_REASSIGNED',
        entityType: 'HANDYMAN_JOB',
        entityId: lockedJob.id,
        actorUserId,
        buildingId: lockedWorkOrder.buildingId,
        vendorWorkId: vendorWork.id,
        summary: 'Handyman job provider and crew reassigned',
        metadata: {
          handymanJobAssignmentId: composition.id,
          previousHandymanJobAssignmentId: current.id,
          vendorAssignmentId: vendorAssignment.id,
          previousVendorAssignmentId: current.vendorAssignmentId,
          vendorWorkId: vendorWork.id,
          handymanProviderId: provider.providerId,
          vendorId: provider.vendorId,
          handymanWorkCrewId: input.handymanWorkCrewId,
          previousHandymanWorkCrewId: current.handymanWorkCrewId,
        },
      },
      tx,
    );

    return {
      composition,
      vendorAssignmentId: vendorAssignment.id,
      vendorWorkId: vendorWork.id,
      workOrderStatusAtCommit: lockedWorkOrder.status,
    };
  });

  const workOrderStatus =
    composed.workOrderStatusAtCommit === 'OPEN'
      ? await convergeWorkOrderToAssigned(job.workOrderId)
      : composed.workOrderStatusAtCommit;

  return {
    job: toPublicHandymanJob(job),
    assignment: toPublicHandymanJobAssignment(composed.composition),
    vendorAssignmentId: composed.vendorAssignmentId,
    vendorWorkId: composed.vendorWorkId,
    workOrderStatus,
  };
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

/** One job by id, behind the actor's client data scope. */
export async function getHandymanJobById(
  jobId: string,
  actorUserId: string,
): Promise<PublicHandymanJob> {
  const job = await handymanJobRepository.findById(jobId);
  if (!job) {
    throw handymanJobNotFoundError();
  }
  await assertClientAccess(actorUserId, job.clientId);
  return toPublicHandymanJob(job);
}

/** Client-scoped job list (client existence + actor data scope). */
export async function listHandymanJobs(
  clientId: string,
  actorUserId: string,
  filters: HandymanJobFilters = {},
): Promise<PublicHandymanJob[]> {
  await requireClient(clientId);
  await assertClientAccess(actorUserId, clientId);
  const records = await handymanJobRepository.listByClient(clientId, filters);
  return records.map(toPublicHandymanJob);
}

/** Full append-only composition history of one job (newest first). */
export async function listHandymanJobAssignments(
  jobId: string,
  actorUserId: string,
): Promise<PublicHandymanJobAssignment[]> {
  const job = await handymanJobRepository.findById(jobId);
  if (!job) {
    throw handymanJobNotFoundError();
  }
  await assertClientAccess(actorUserId, job.clientId);
  const records = await handymanJobRepository.listAssignmentsByJobId(job.id);
  return records.map(toPublicHandymanJobAssignment);
}

export const handymanJobService = {
  assignHandymanJobProviderAndCrew,
  createHandymanJob,
  getHandymanJobById,
  listHandymanJobAssignments,
  listHandymanJobs,
  reassignHandymanJobProviderAndCrew,
  toPublicHandymanJob,
  toPublicHandymanJobAssignment,
};
