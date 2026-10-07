/**
 * BE-22I — Approval via shared Document foundation.
 * Reuses BE-09 approval/workflow foundation (reviews + available_actions).
 */

export const DOCUMENT_APPROVAL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export type DocumentApprovalStatus = (typeof DOCUMENT_APPROVAL_STATUSES)[number];

export type DocumentApprovalRecord = {
  id: string; // review id
  documentId: string;
  versionId: string | null;
  clientId: string;
  buildingId: string | null;
  contextType: string;
  status: 'PENDING' | 'COMPLETED';
  decision: 'APPROVED' | 'REJECTED' | null;
  reviewerUserId: string;
  notes: string | null;
  reviewedAt: Date | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicDocumentApproval = {
  id: string;
  documentId: string;
  versionId: string | null;
  clientId: string;
  buildingId: string | null;
  contextType: string;
  approvalStatus: DocumentApprovalStatus;
  decision: 'APPROVED' | 'REJECTED' | null;
  reviewerUserId: string;
  notes: string | null;
  reviewedAt: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateDocumentApprovalInput = {
  documentId: string;
  versionId?: string | null;
  approverUserId: string;
  notes?: string | null;
};

export type DocumentApprovalDecisionInput = {
  notes?: string | null;
};

export type DocumentApprovalFilters = {
  documentId?: string;
  buildingId?: string;
  reviewerUserId?: string;
  status?: 'PENDING' | 'COMPLETED';
};

export const DOCUMENT_APPROVAL_ACTIONS = ['APPROVE', 'REJECT'] as const;
export type DocumentApprovalAction = (typeof DOCUMENT_APPROVAL_ACTIONS)[number];
