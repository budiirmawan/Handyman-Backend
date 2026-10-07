import { randomUUID } from 'node:crypto';
import { getPool, withTransaction } from '../../database';
import type { ReviewDecision } from '../reviews/review.types';
import type {
  CreatePermitApprovalInput,
  PermitApprovalPendingFilters,
  PermitApprovalRecord,
} from './permit-approval.types';

const SELECT = `
  pab.id,
  pab.review_id AS "reviewId",
  pab.permit_application_id AS "permitApplicationId",
  pa.permit_id AS "permitId",
  p.permit_number AS "permitReference",
  p.client_id AS "clientId",
  p.building_id AS "buildingId",
  p.contractor_context_type AS "contractorContextType",
  p.contractor_vendor_id AS "contractorVendorId",
  pa.status AS "applicationStatus",
  p.status AS "permitStatus",
  pab.approval_stage AS "approvalStage",
  pab.approval_type AS "approvalType",
  r.reviewer_user_id AS "approverUserId",
  r.status AS "reviewStatus",
  r.decision,
  r.reviewed_at AS "decisionAt",
  r.notes AS "decisionNotes",
  pab.created_by_user_id AS "createdByUserId",
  pab.created_at AS "createdAt",
  r.updated_at AS "updatedAt"
`;

const JOINS = `
  FROM permit_approval_bindings pab
  JOIN reviews r ON r.id = pab.review_id
  JOIN permit_applications pa ON pa.id = pab.permit_application_id
  JOIN permits p ON p.id = pa.permit_id
`;

async function create(input: {
  permitApplicationId: string;
  clientId: string;
  createdByUserId: string;
  approval: CreatePermitApprovalInput;
}): Promise<PermitApprovalRecord> {
  const bindingId = randomUUID();
  const reviewId = randomUUID();
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO reviews
         (id, client_id, target_type, target_id, reviewer_user_id,
          status, notes)
       VALUES ($1, $2, 'PERMIT_APPLICATION', $3, $4, 'PENDING', $5)`,
      [
        reviewId,
        input.clientId,
        input.permitApplicationId,
        input.approval.approverUserId,
        input.approval.notes ?? null,
      ],
    );
    await client.query(
      `INSERT INTO permit_approval_bindings
         (id, permit_application_id, review_id, approval_stage,
          approval_type, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        bindingId,
        input.permitApplicationId,
        reviewId,
        input.approval.approvalStage,
        input.approval.approvalType,
        input.createdByUserId,
      ],
    );
  });
  return (await findById(bindingId)) as PermitApprovalRecord;
}

async function findById(id: string): Promise<PermitApprovalRecord | null> {
  const result = await getPool().query<PermitApprovalRecord>(
    `SELECT ${SELECT} ${JOINS} WHERE pab.id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findByApplicationStageType(input: {
  permitApplicationId: string;
  approvalStage: string;
  approvalType: string;
}): Promise<PermitApprovalRecord | null> {
  const result = await getPool().query<PermitApprovalRecord>(
    `SELECT ${SELECT} ${JOINS}
     WHERE pab.permit_application_id = $1
       AND pab.approval_stage = $2
       AND pab.approval_type = $3`,
    [input.permitApplicationId, input.approvalStage, input.approvalType],
  );
  return result.rows[0] ?? null;
}

async function listByApplication(
  permitApplicationId: string,
): Promise<PermitApprovalRecord[]> {
  const result = await getPool().query<PermitApprovalRecord>(
    `SELECT ${SELECT} ${JOINS}
     WHERE pab.permit_application_id = $1
     ORDER BY pab.created_at, pab.id`,
    [permitApplicationId],
  );
  return result.rows;
}

async function listPending(
  filters: PermitApprovalPendingFilters,
  accessibleBuildingIds: string[],
): Promise<PermitApprovalRecord[]> {
  if (accessibleBuildingIds.length === 0) return [];
  const values: unknown[] = [accessibleBuildingIds];
  const conditions = [
    'p.building_id = ANY($1::uuid[])',
    "r.status = 'PENDING'",
  ];
  if (filters.buildingId) {
    values.push(filters.buildingId);
    conditions.push(`p.building_id = $${values.length}`);
  }
  if (filters.approverUserId) {
    values.push(filters.approverUserId);
    conditions.push(`r.reviewer_user_id = $${values.length}`);
  }
  if (filters.approvalStage) {
    values.push(filters.approvalStage);
    conditions.push(`pab.approval_stage = $${values.length}`);
  }
  if (filters.approvalType) {
    values.push(filters.approvalType);
    conditions.push(`pab.approval_type = $${values.length}`);
  }
  const result = await getPool().query<PermitApprovalRecord>(
    `SELECT ${SELECT} ${JOINS}
     WHERE ${conditions.join(' AND ')}
     ORDER BY pab.created_at, pab.id`,
    values,
  );
  return result.rows;
}

async function completeReview(
  reviewId: string,
  decision: ReviewDecision,
  notes: string | null,
): Promise<boolean> {
  const result = await getPool().query(
    `UPDATE reviews
     SET decision = $2, notes = $3, status = 'COMPLETED',
         reviewed_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND target_type = 'PERMIT_APPLICATION'
       AND status = 'PENDING'`,
    [reviewId, decision, notes],
  );
  return result.rowCount === 1;
}

export const permitApprovalRepository = {
  completeReview,
  create,
  findByApplicationStageType,
  findById,
  listByApplication,
  listPending,
};
