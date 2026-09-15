/**
 * CR-BE-REPORT-READ-01 PART 01 — Vendor Service Register read contract types.
 *
 * READ MODEL ONLY. One flat row per BE-15B Vendor Work, joining the existing
 * authoritative records (assignment, vendor, work order, asset, completion
 * report, service report, verification review, rework cycles, checklist
 * bindings, BAST) for Reporting consumption.
 *
 * WHAT THIS CONTRACT IS NOT
 *   - It creates no business entity, lifecycle status, or persistence.
 *   - It performs no business calculation and no inference: every status,
 *     decision, and timestamp is the authoritative value verbatim. In
 *     particular it never infers completion, acceptance, verification, or
 *     overdue from the presence or combination of other records.
 *   - Single-identity checklist fields are deliberately absent: bindings
 *     are unique per (vendor work, template), so no authoritative singleton
 *     binding/execution exists per vendor work. Only the direct binding
 *     count is exposed; inventing a "primary binding" rule would be new
 *     business logic owned by BE-15C, not by this read model.
 *   - BAST acceptance is exposed as the two stored states verbatim (the
 *     binding's own `acceptance_status` and the scope-constrained canonical
 *     `bast_documents.acceptance_status`). Resolution between them follows
 *     the BAST authority's mapper and is not replicated here.
 *
 * Grain: exactly one row per `vendor_works` row in scope. Optional links
 * are LEFT-joined, so a missing report / review / rework / BAST never
 * removes the base vendor-work row.
 */

export type VendorServiceRegisterFilters = {
  /**
   * Optional. Omitted means "roll up across every Building the caller
   * can access" (BE-23H convention); supplied means the Building is
   * access-asserted.
   */
  buildingId?: string;
  /** BE-06A vendor narrowing. */
  vendorId?: string;
  /** BE-08 work order narrowing. */
  workOrderId?: string;
  /** BE-05 asset narrowing (via the work order's asset binding). */
  assetId?: string;
  /** BE-15B vendor-work status narrowing, verbatim lifecycle value. */
  vendorWorkStatus?: string;
  /**
   * Latest-verification decision narrowing (APPROVED / REJECTED /
   * REWORK_REQUIRED), matched against the latest review only.
   */
  verificationDecision?: string;
  /** ISO date (YYYY-MM-DD) or datetime; day windows are UTC, matching BE-07. */
  dateFrom?: string;
  /** ISO date (YYYY-MM-DD) or datetime; day windows are UTC, matching BE-07. */
  dateTo?: string;
};

/** One flat register row. Every status/decision is verbatim; every link nullable. */
export type PublicVendorServiceRegisterRow = {
  /* Identity */
  vendorWorkId: string;
  vendorAssignmentId: string;
  /** `vendor_assignments.assigned_at` — the authoritative assignment instant. */
  assignedAt: string;
  vendorId: string;
  vendorCode: string;
  vendorName: string;
  /* Work order */
  workOrderId: string;
  workOrderNumber: string;
  workOrderStatus: string;
  /** `work_orders.functional_location_id` verbatim; null = no WO location binding. */
  functionalLocationId: string | null;
  /* Asset (via the work order binding; null = location-only work order) */
  assetId: string | null;
  assetCode: string | null;
  assetName: string | null;
  /* Vendor work */
  vendorWorkStatus: string;
  vendorWorkStartedAt: string | null;
  vendorWorkCompletedAt: string | null;
  /* Checklist — direct binding count only (see module contract note). */
  checklistBindingCount: number;
  /* Completion report (BE-15F; at most one per vendor work, schema-enforced) */
  completionReportId: string | null;
  completionReportStatus: string | null;
  /**
   * `completed_at`, set by the authority exactly at submission
   * (migration 0160); null until SUBMITTED.
   */
  completionSubmittedAt: string | null;
  /* Service report (BE-15G; at most one per vendor work, schema-enforced) */
  serviceReportId: string | null;
  serviceReportNumber: string | null;
  serviceReportStatus: string | null;
  /** `service_date` (DATE) as YYYY-MM-DD. */
  serviceReportDate: string | null;
  serviceReportFinalizedAt: string | null;
  /* Latest BM verification (BE-15I review; null = never verified) */
  verificationReviewId: string | null;
  verificationDecision: string | null;
  verificationReviewedAt: string | null;
  /* Rework cycles (BE-15J) */
  /** Direct count of persisted `vendor_rework_cycles` rows. No interpretation. */
  reworkCount: number;
  /** Latest cycle per the authoritative cycle ordering; null = no rework. */
  latestReworkId: string | null;
  latestReworkStatus: string | null;
  /* BAST / acceptance (BE-15H binding; at most one per vendor work) */
  bastBindingId: string | null;
  bastNumber: string | null;
  /** `bast_date` (DATE) as YYYY-MM-DD. */
  bastDate: string | null;
  /** The binding's own stored acceptance status, verbatim. */
  bastAcceptanceStatus: string | null;
  bastSubmittedAt: string | null;
  bastAcceptedAt: string | null;
  /** Scope-constrained canonical `bast_documents` row, when linked. */
  canonicalBastDocumentId: string | null;
  /** Canonical acceptance status, verbatim. */
  canonicalBastAcceptanceStatus: string | null;
  /* Traceability scope */
  buildingId: string;
  clientId: string;
};

export type PublicVendorServiceRegister = {
  /** Null when the register is a multi-building rollup. */
  buildingId: string | null;
  /** Every Building actually included in the rows. */
  buildingScope: string[];
  dateFrom: string | null;
  dateTo: string | null;
  /** The evaluation instant. */
  asOf: string;
  rows: PublicVendorServiceRegisterRow[];
};
