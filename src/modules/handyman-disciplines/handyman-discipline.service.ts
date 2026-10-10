import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { withTransaction } from '../../database';
import { buildingAccessDeniedError, contextAccessService } from '../context-access';
import { serviceCatalogRepository } from '../service-catalog';
import {
  handymanDisciplineAssociationConflictError,
  handymanDisciplineInvalidError,
} from './handyman-discipline.errors';
import { handymanDisciplineRepository } from './handyman-discipline.repository';
import type {
  CreateHandymanDisciplineServiceAssociationInput,
  HandymanDisciplineServiceAssociationRecord,
} from './handyman-discipline.types';

/**
 * CR-HM-03 PART 03 — FROZEN F9 catalogue→discipline association service.
 *
 * Handyman-owned: one ACTIVE same-client catalog entry → one ACTIVE
 * discipline. It never modifies `service_catalog` semantics, never reads
 * its free-text `category` as scope authority, and carries no
 * provider/vendor meaning.
 */

const ASSOCIATION_UNIQUE_CONSTRAINT =
  'handyman_discipline_service_associations_catalog_unique';

function isAssociationUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate?.code === '23505' &&
    candidate?.constraint === ASSOCIATION_UNIQUE_CONSTRAINT
  );
}

/** Associate a catalogue entry with exactly one F9 discipline. */
export async function associateHandymanDisciplineToServiceCatalog(
  input: CreateHandymanDisciplineServiceAssociationInput,
  actorUserId: string,
): Promise<HandymanDisciplineServiceAssociationRecord> {
  const fields: Array<[string, string, string]> = [
    ['serviceCatalogId', input.serviceCatalogId, 'a valid UUID'],
    ['handymanDisciplineId', input.handymanDisciplineId, 'a valid UUID'],
    ['actorUserId', actorUserId, 'a valid local user UUID'],
  ];
  const problems = fields
    .filter(([, value]) => !isValidUuid(value))
    .map(([field]) => ({ field, message: `${field} must be a valid UUID.` }));
  if (problems.length > 0) {
    throw AppError.validation('Request validation failed.', problems);
  }

  try {
    return await withTransaction(async (tx) => {
      const catalog = await serviceCatalogRepository.findById(
        tx,
        input.serviceCatalogId,
      );
      if (!catalog) {
        throw AppError.notFound('Service catalogue entry not found.');
      }
      if (catalog.status !== 'ACTIVE') {
        throw AppError.validation('Request validation failed.', [
          {
            field: 'serviceCatalogId',
            message: 'Only ACTIVE service catalogue entries can be associated.',
          },
        ]);
      }
      const discipline = await handymanDisciplineRepository.findDisciplineById(
        tx,
        input.handymanDisciplineId,
      );
      if (!discipline || discipline.status !== 'ACTIVE') {
        throw handymanDisciplineInvalidError();
      }
      if (
        !(await contextAccessService.canAccessClient(
          actorUserId,
          catalog.clientId,
        ))
      ) {
        throw buildingAccessDeniedError();
      }
      return handymanDisciplineRepository.insertAssociation(tx, {
        clientId: catalog.clientId,
        handymanDisciplineId: discipline.id,
        serviceCatalogId: catalog.id,
        createdByUserId: actorUserId,
      });
    });
  } catch (error) {
    if (isAssociationUniqueViolation(error)) {
      throw handymanDisciplineAssociationConflictError();
    }
    throw error;
  }
}

// CR-HM-SEC-02 PART 05 (dead-helper hygiene): the
// `getHandymanDisciplineAssociation` service entry point is removed —
// it had ZERO callers across src/ and tests/ (verified: only this
// module's own re-exports referenced it). The association itself stays
// client-scoped-only (frozen D6): `associateHandymanDisciplineToServiceCatalog`
// keeps its contractual client-level authority and gains NO building
// scope. The repository functionality used by request diagnosis
// (`findDisciplineById`, `findAssociationByCatalog`) is preserved
// unchanged.

export const handymanDisciplineService = {
  associateHandymanDisciplineToServiceCatalog,
};
