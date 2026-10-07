/**
 * BE-10D — Equipment Log Sheet Binding domain types.
 *
 * The minimal binding that associates a BE-05 Asset / Equipment with a BE-07
 * Form Template (the log sheet definition), an optional published Template
 * Version snapshot, and an optional BE-04 Functional Location refinement.
 *
 * Log sheet rows are BE-07 Form Instances; responses live in BE-07's own
 * `form_responses` store. This module owns only the binding reference and
 * the execution-context read model — no log sheet form, measurement, or
 * execution engine exists here.
 */

export const LOG_SHEET_BINDING_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type LogSheetBindingStatus = (typeof LOG_SHEET_BINDING_STATUSES)[number];

export function isLogSheetBindingStatus(
  value: unknown,
): value is LogSheetBindingStatus {
  return (
    typeof value === 'string' &&
    (LOG_SHEET_BINDING_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type LogSheetBindingRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  assetId: string;
  formTemplateId: string;
  formTemplateVersionId: string | null;
  functionalLocationId: string | null;
  status: LogSheetBindingStatus;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicLogSheetBinding = {
  id: string;
  clientId: string;
  buildingId: string;
  assetId: string;
  formTemplateId: string;
  formTemplateVersionId: string | null;
  functionalLocationId: string | null;
  status: LogSheetBindingStatus;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateLogSheetBindingInput = {
  assetId: string;
  formTemplateId: string;
  formTemplateVersionId?: string | null;
  functionalLocationId?: string | null;
  status?: LogSheetBindingStatus;
  createdByUserId: string;
};

export type UpdateLogSheetBindingInput = {
  formTemplateVersionId?: string | null;
  functionalLocationId?: string | null;
  status?: LogSheetBindingStatus;
};

/** The shared BE-07 form instance, as started from a log sheet binding. */
export type PublicLogSheetExecution = {
  id: string;
  formTemplateVersionId: string;
  logSheetBindingId: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Resolved context for a log sheet execution: the authoritative Asset /
 * Building / Functional Location plus the template / version the execution
 * is tied to. Derived from the binding and BE-07 stores — never stored a
 * second time.
 */
export type PublicLogSheetExecutionContext = {
  execution: PublicLogSheetExecution;
  asset: {
    id: string;
    assetCode: string;
    assetName: string;
    status: string;
  };
  building: {
    id: string;
    code: string;
    name: string;
  };
  functionalLocation: {
    id: string;
    code: string;
    name: string;
    status: string;
  } | null;
  template: {
    id: string;
    code: string;
    name: string;
  };
  version: {
    id: string;
    versionNumber: number;
    status: string;
  };
};
