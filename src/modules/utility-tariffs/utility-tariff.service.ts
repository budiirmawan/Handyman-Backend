import { getPool } from '../../database';
import { buildingNotFoundError } from '../buildings';
import { assertActiveAllowedCurrencyCommand } from '../client-monetary-contexts';
import { contextAccessService } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { utilityTariffInvalidError, utilityTariffOverlapError } from './utility-tariff.errors';
import { utilityTariffRepository } from './utility-tariff.repository';
import type {
  CreateUtilityTariffInput,
  PublicUtilityTariff,
  UtilityTariffFilters,
  UtilityTariffRecord,
} from './utility-tariff.types';

const toPublic = (record: UtilityTariffRecord): PublicUtilityTariff => ({
  ...record,
  ratePerUom: Number(record.ratePerUom),
  effectiveFrom: record.effectiveFrom.toISOString(),
  effectiveUntil: record.effectiveUntil?.toISOString() ?? null,
  createdAt: record.createdAt.toISOString(),
  updatedAt: record.updatedAt.toISOString(),
});

export async function createUtilityTariff(
  input: CreateUtilityTariffInput,
  actorUserId: string,
): Promise<PublicUtilityTariff> {
  await contextAccessService.assertBuildingAccess(actorUserId, input.buildingId);
  const clientId = await utilityTariffRepository.resolveBuildingClient(input.buildingId);
  if (!clientId) throw buildingNotFoundError();

  /* CUR-02 PART 04 — the Utility Tariff is the governed currency entry point
     for the calculation -> bill chain. On create, the explicit currency must
     be an ACTIVE Currency Master code allowed for the resolved Building Client.
     No IDR/base/default inference and no silent substitution: the exact
     submitted currency is the immutable snapshot (or the command fails closed). */
  await assertActiveAllowedCurrencyCommand(clientId, input.currency);

  const uom = await getPool().query<{ clientId: string; status: string }>(
    'SELECT client_id AS "clientId", status FROM units_of_measure WHERE id = $1',
    [input.uomId],
  );
  if (!uom.rows[0] || uom.rows[0].clientId !== clientId || uom.rows[0].status !== 'ACTIVE') {
    throw utilityTariffInvalidError('Tariff UOM must be an active UOM owned by the Building Client.');
  }

  try {
    const record = await utilityTariffRepository.create(clientId, input);
    await recordOperationalEvent({
      clientId,
      buildingId: input.buildingId,
      eventType: 'UTILITY_TARIFF_CREATED',
      entityType: 'UTILITY_TARIFF',
      entityId: record.id,
      actorUserId,
      summary: `${input.utilityType} tariff configured for Building`,
      metadata: { utilityType: input.utilityType, currency: input.currency,
        uomId: input.uomId, ratePerUom: input.ratePerUom,
        effectiveFrom: input.effectiveFrom.toISOString(),
        effectiveUntil: input.effectiveUntil?.toISOString() ?? null },
    });
    return toPublic(record);
  } catch (error) {
    const candidate = error as { code?: string; constraint?: string };
    if (candidate.code === '23P01' && candidate.constraint === 'utility_tariffs_active_period_exclusion') {
      throw utilityTariffOverlapError();
    }
    throw error;
  }
}

export async function listUtilityTariffs(
  buildingId: string,
  filters: UtilityTariffFilters,
  actorUserId: string,
): Promise<PublicUtilityTariff[]> {
  await contextAccessService.assertBuildingAccess(actorUserId, buildingId);
  if (!(await utilityTariffRepository.resolveBuildingClient(buildingId))) throw buildingNotFoundError();
  return (await utilityTariffRepository.listByBuilding(buildingId, filters)).map(toPublic);
}

export const utilityTariffService = { createUtilityTariff, listUtilityTariffs };
