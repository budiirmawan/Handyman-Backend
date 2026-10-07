/**
 * BE-12J — Visitor / Security Binding domain types.
 *
 * A Security-side binding that records the Security operational context
 * for an (opaque, future-authoritative) Visit reference. The
 * authoritative Visitor / Visit domain does NOT exist in this
 * repository today — the `invitations` module is the BE-01
 * user-invitation flow, not a physical visitor domain. To keep the
 * Security binding future-proof without inventing a Visitor
 * lifecycle, this binding carries an opaque `external_visit_reference`
 * — a free-form string supplied by the caller that a future Visitor
 * module can later match against its authoritative id.
 *
 * No visitor personal data (name, contact, ID number, photo, plate,
 * etc.) is copied into this binding. The binding only stores:
 *   - the client + building
 *   - an optional Security Post (BE-12A) anchor
 *   - an optional Security Workforce (BE-03) anchor
 *   - the external visit reference (future-link hook)
 *   - a free-form security context / notes
 *   - the binding's own ACTIVE/INACTIVE status
 *   - audit timestamps + the user who created the binding
 *
 * The binding's own status is independent of any future Visitor
 * lifecycle — INACTIVE bindings do not block a re-bind and never
 * affect a future authoritative Visitor record.
 */

export const SECURITY_VISITOR_BINDING_STATUSES = [
  'ACTIVE',
  'INACTIVE',
] as const;

export type SecurityVisitorBindingStatus =
  (typeof SECURITY_VISITOR_BINDING_STATUSES)[number];

export function isSecurityVisitorBindingStatus(
  value: unknown,
): value is SecurityVisitorBindingStatus {
  return (
    typeof value === 'string' &&
    (SECURITY_VISITOR_BINDING_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type SecurityVisitorBindingRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  securityPostId: string | null;
  securityWorkforceId: string | null;
  externalVisitReference: string;
  securityContext: string | null;
  status: SecurityVisitorBindingStatus;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Safe public representation exposed through the API. The external
 * visit reference is intentionally NOT a foreign key — it is an
 * opaque future-link hook. A future Visitor module can later match
 * this value to its authoritative id.
 */
export type PublicSecurityVisitorBinding = {
  id: string;
  clientId: string;
  buildingId: string;
  securityPostId: string | null;
  securityWorkforceId: string | null;
  externalVisitReference: string;
  securityContext: string | null;
  status: SecurityVisitorBindingStatus;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateSecurityVisitorBindingInput = {
  buildingId: string;
  securityPostId?: string | null;
  securityWorkforceId?: string | null;
  externalVisitReference: string;
  securityContext?: string | null;
  status?: SecurityVisitorBindingStatus;
  createdByUserId: string;
};

export type UpdateSecurityVisitorBindingInput = {
  securityPostId?: string | null;
  securityWorkforceId?: string | null;
  externalVisitReference?: string;
  securityContext?: string | null;
  status?: SecurityVisitorBindingStatus;
};

export type SecurityVisitorBindingListFilters = {
  buildingId?: string;
  securityPostId?: string;
  securityWorkforceId?: string;
  externalVisitReference?: string;
  status?: SecurityVisitorBindingStatus;
};
