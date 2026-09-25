/**
 * CR-BE-ASSISTED-INTAKE-01 PART 01 — assisted-intake provenance shared
 * channel type.
 *
 * Shared by the Tenant Service Request (BE-14E) and Tenant Complaint (BE-14F)
 * intake records. The vocabulary is EXACTLY the assisted-intake channels:
 * portal/mobile self-service and the staff-assisted channels (phone,
 * WhatsApp, email, walk-in / front desk), plus an explicit OTHER for channels
 * the current vocabulary does not cover. This is a vocabulary only — it does
 * NOT infer an intake channel from `createdByUserId` and it is nullable
 * everywhere it is stored so legacy rows (inserted before assisted-intake
 * provenance existed) remain representable as NULL.
 */

export const INTAKE_CHANNELS = [
  'PORTAL',
  'MOBILE',
  'PHONE',
  'WHATSAPP',
  'EMAIL',
  'WALK_IN',
  'FRONT_DESK',
  'OTHER',
] as const;

export type IntakeChannel = (typeof INTAKE_CHANNELS)[number];

export function isIntakeChannel(value: unknown): value is IntakeChannel {
  return typeof value === 'string' &&
    (INTAKE_CHANNELS as readonly string[]).includes(value);
}
