/**
 * CR-HM-03 PART 03 — Handyman discipline registry types (FROZEN F9).
 *
 * The registry is the ONLY machine-readable scope authority:
 * `code` / `name` / `scopeClass`. `service_catalog.category` remains
 * descriptive free-form metadata and is never consulted as authority.
 */

export const HANDYMAN_DISCIPLINE_SCOPE_CLASSES = [
  'GENERAL_HANDYMAN',
  'SPECIALIST',
  'OUT_OF_HANDYMAN_SCOPE',
] as const;
export type HandymanDisciplineScopeClass =
  (typeof HANDYMAN_DISCIPLINE_SCOPE_CLASSES)[number];

export function isHandymanDisciplineScopeClass(
  value: unknown,
): value is HandymanDisciplineScopeClass {
  return (
    typeof value === 'string' &&
    (HANDYMAN_DISCIPLINE_SCOPE_CLASSES as readonly string[]).includes(value)
  );
}

/** F9 registry row. */
export type HandymanDisciplineRecord = {
  id: string;
  code: string;
  name: string;
  scopeClass: HandymanDisciplineScopeClass;
  status: 'ACTIVE' | 'INACTIVE';
};

/** Handyman-owned catalog-entry → discipline association (one per entry). */
export type HandymanDisciplineServiceAssociationRecord = {
  id: string;
  /** Verbatim snapshot of the catalogue row's client. */
  clientId: string;
  handymanDisciplineId: string;
  serviceCatalogId: string;
  createdByUserId: string;
  createdAt: Date;
};

/** Caller input for establishing an association — client is NEVER input. */
export type CreateHandymanDisciplineServiceAssociationInput = {
  serviceCatalogId: string;
  handymanDisciplineId: string;
};

export type NewHandymanDisciplineServiceAssociationRecord = Omit<
  HandymanDisciplineServiceAssociationRecord,
  'id' | 'createdAt'
>;
