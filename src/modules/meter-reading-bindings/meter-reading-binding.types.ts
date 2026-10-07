/**
 * BE-10C — Meter Reading Binding domain types.
 *
 * The minimal binding that associates a BE-05 Asset / Equipment with a BE-07
 * numeric Form Field (the meter-reading definition), a BE-07 UOM, and an
 * optional BE-04 Functional Location refinement. Readings are submitted into
 * BE-07's own `form_responses` store through a shared BE-07 Form Instance —
 * no second response or measurement service exists here.
 */

export const METER_READING_BINDING_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type MeterReadingBindingStatus =
  (typeof METER_READING_BINDING_STATUSES)[number];

export function isMeterReadingBindingStatus(
  value: unknown,
): value is MeterReadingBindingStatus {
  return (
    typeof value === 'string' &&
    (METER_READING_BINDING_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type MeterReadingBindingRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  assetId: string;
  formFieldId: string;
  uomId: string;
  functionalLocationId: string | null;
  /** Binding-level tightening of the field's configured measurement range. */
  minimumValue: string | null;
  maximumValue: string | null;
  status: MeterReadingBindingStatus;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicMeterReadingBinding = {
  id: string;
  clientId: string;
  buildingId: string;
  assetId: string;
  formFieldId: string;
  uomId: string;
  functionalLocationId: string | null;
  minimumValue: number | null;
  maximumValue: number | null;
  status: MeterReadingBindingStatus;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateMeterReadingBindingInput = {
  assetId: string;
  formFieldId: string;
  uomId?: string;
  functionalLocationId?: string | null;
  minimumValue?: number;
  maximumValue?: number;
  status?: MeterReadingBindingStatus;
  createdByUserId: string;
};

export type UpdateMeterReadingBindingInput = {
  uomId?: string;
  functionalLocationId?: string | null;
  minimumValue?: number;
  maximumValue?: number;
  status?: MeterReadingBindingStatus;
};

/** The shared BE-07 form instance, as started from a meter reading binding. */
export type PublicMeterReadingExecution = {
  id: string;
  formTemplateVersionId: string;
  meterReadingBindingId: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** A submitted reading, stored in BE-07's own `form_responses` row. */
export type PublicMeterReading = {
  executionId: string;
  formInstanceId: string;
  versionFieldId: string;
  value: number;
  uom: {
    id: string;
    code: string;
    symbol: string;
  };
  minimumValue: number | null;
  maximumValue: number | null;
  notes: string | null;
  submittedAt: string;
};

/**
 * Resolved context for a reading execution: the authoritative Asset /
 * Building / Functional Location / UOM plus the effective measurement range
 * and the current reading. Derived from the binding and BE-07 stores — never
 * stored a second time.
 */
export type PublicMeterReadingContext = {
  execution: PublicMeterReadingExecution;
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
  uom: {
    id: string;
    code: string;
    name: string;
    symbol: string;
  };
  minimumValue: number | null;
  maximumValue: number | null;
  currentValue: number | null;
};
