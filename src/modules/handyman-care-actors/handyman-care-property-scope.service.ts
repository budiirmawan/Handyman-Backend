import { withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { buildingAccessDeniedError, contextAccessService } from '../context-access';
import { clientRepository } from '../clients';
import { recordOperationalEvent } from '../operational-events';
import { permissionService } from '../permissions';
import { propertyRepository } from '../properties';
import { userRepository } from '../users';
import { handymanCareActorRepository } from './handyman-care-actor.repository';
import {
  handymanCarePropertyScopeRepository as repository,
  type CarePropertyGrantRecord,
} from './handyman-care-property-scope.repository';

/**
 * PART 02 only: in-process property grant administration and scope resolution.
 * A local User is the ADMINISTRATIVE grantor, never the BM Customer Care actor.
 * This module does not authenticate BM handoffs or create Handyman requests.
 */
export type CarePropertyGrant = Omit<CarePropertyGrantRecord, 'grantedAt' | 'revokedAt'> & {
  grantedAt: string;
  revokedAt: string | null;
};

function publicGrant(row: CarePropertyGrantRecord): CarePropertyGrant {
  return {
    ...row,
    grantedAt: row.grantedAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

function conflict(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_CARE_PROPERTY_GRANT_CONFLICT,
    message: 'Care actor already has an active grant for this property.',
    statusCode: 409,
  });
}

function assertId(id: string, field: string): void {
  if (typeof id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw AppError.validation('Scope validation failed.', [
      { field, message: `${field} must be a UUID.` },
    ]);
  }
}

async function assertAdministrator(userId: string, propertyId: string): Promise<void> {
  assertId(userId, 'administratorUserId');
  const user = await userRepository.findById(userId);
  if (user?.status !== 'ACTIVE' ||
    !(await permissionService.resolvePermissionsForUser(userId)).includes('property.manage') ||
    !(await contextAccessService.canAccessProperty(userId, propertyId))) {
    throw buildingAccessDeniedError();
  }
}

async function resolveProperty(propertyId: string, clientId: string, active: boolean) {
  assertId(propertyId, 'propertyId');
  assertId(clientId, 'clientId');
  const property = await propertyRepository.findById(propertyId);
  if (!property || property.clientId !== clientId || (active && property.status !== 'ACTIVE')) {
    throw buildingAccessDeniedError();
  }
  const client = await clientRepository.findById(clientId);
  if (!client || (active && client.status !== 'ACTIVE')) {
    throw buildingAccessDeniedError();
  }
  return property;
}

/** Admin-only grant. A revoked grant can be regranted as a NEW row. */
export async function grantCareActorProperty(
  input: { careActorId: string; propertyId: string; clientId: string },
  administratorUserId: string,
): Promise<CarePropertyGrant> {
  assertId(input.careActorId, 'careActorId');
  await resolveProperty(input.propertyId, input.clientId, true);
  await assertAdministrator(administratorUserId, input.propertyId);
  const actor = await handymanCareActorRepository.findById(input.careActorId);
  const integration = actor
    ? await handymanCareActorRepository.findIntegrationActorScopeById(actor.integrationId)
    : null;
  if (actor?.status !== 'ACTIVE' || integration?.status !== 'ACTIVE' ||
    integration.actorCapability !== 'CUSTOMER_CARE') {
    throw buildingAccessDeniedError();
  }

  try {
    return await withTransaction(async (tx) => {
      if (await repository.findActive(tx, input.careActorId, input.propertyId)) {
        throw conflict();
      }
      const row = await repository.insert(tx, {
        careActorId: actor.id,
        propertyId: input.propertyId,
        grantedByUserId: administratorUserId,
      });
      await recordOperationalEvent({
        clientId: input.clientId,
        actorUserId: administratorUserId,
        eventType: 'HANDYMAN_CARE_PROPERTY_GRANT_CREATED',
        entityType: 'HANDYMAN_CARE_PROPERTY_GRANT',
        entityId: row.id,
        summary: 'Customer Care property grant created.',
        metadata: { careActorId: actor.id, propertyId: input.propertyId },
      }, tx);
      return publicGrant(row);
    });
  } catch (error) {
    const e = error as { code?: string; constraint?: string };
    if (e?.code === '23505' && e.constraint === 'handyman_care_property_grants_active_unique') {
      throw conflict();
    }
    throw error;
  }
}

/** Revocation is irreversible. Revoke while actor/property is inactive too. */
export async function revokeCareActorProperty(
  input: { careActorId: string; propertyId: string; clientId: string },
  administratorUserId: string,
): Promise<CarePropertyGrant> {
  assertId(input.careActorId, 'careActorId');
  await resolveProperty(input.propertyId, input.clientId, false);
  await assertAdministrator(administratorUserId, input.propertyId);
  return withTransaction(async (tx) => {
    const row = await repository.revoke(
      tx, input.careActorId, input.propertyId, administratorUserId,
    );
    if (!row) throw buildingAccessDeniedError();
    await recordOperationalEvent({
      clientId: input.clientId,
      actorUserId: administratorUserId,
      eventType: 'HANDYMAN_CARE_PROPERTY_GRANT_REVOKED',
      entityType: 'HANDYMAN_CARE_PROPERTY_GRANT',
      entityId: row.id,
      summary: 'Customer Care property grant revoked.',
      metadata: { careActorId: row.careActorId, propertyId: row.propertyId },
    }, tx);
    return publicGrant(row);
  });
}

/**
 * Fail-closed read: derive Property from Building, check it belongs to the
 * represented Client, AND require active grant/actor/integration/property/
 * building/Client. Null is not authority. No occupant/PIC/user substitution.
 */
export async function resolveActiveCareActorPropertyScope(input: {
  careActorId: string;
  buildingId: string;
  clientId: string;
}): Promise<CarePropertyGrant | null> {
  if (!input || typeof input.careActorId !== 'string' ||
      typeof input.buildingId !== 'string' || typeof input.clientId !== 'string') {
    return null;
  }
  const row = await repository.resolveActiveForBuilding(
    input.careActorId, input.buildingId, input.clientId,
  );
  return row ? publicGrant(row) : null;
}

export const handymanCarePropertyScopeService = {
  grantCareActorProperty,
  revokeCareActorProperty,
  resolveActiveCareActorPropertyScope,
};
