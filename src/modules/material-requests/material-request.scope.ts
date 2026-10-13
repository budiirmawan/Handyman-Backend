import { resolveBuildingsForUser } from '../building-assignments';
import type { MaterialRequestItemScope } from './material-request.types';

/** BE-02G remains the sole assignment/hierarchy resolver. Empty is never global. */
export async function resolveMaterialScope(actorUserId: string): Promise<MaterialRequestItemScope> {
  if (!actorUserId) return [];
  const contexts = await resolveBuildingsForUser(actorUserId);
  return contexts.flatMap((context) => context.client
    ? [{ clientId: context.client.id, buildingId: context.building.id }] : []);
}

export function materialScopePredicate(alias: string, parameter: number): string {
  return `EXISTS (SELECT 1 FROM jsonb_to_recordset($${parameter}::jsonb)
    AS authorized("clientId" uuid, "buildingId" uuid)
    WHERE authorized."clientId" = ${alias}.client_id
      AND authorized."buildingId" = ${alias}.building_id)`;
}

/** Alias mr; independent foreign keys do not establish chain ownership. */
export const MATERIAL_CHAIN_PREDICATE = `
  EXISTS (SELECT 1 FROM purchase_requests p
    WHERE p.id = mr.purchase_request_id AND p.client_id = mr.client_id AND p.building_id = mr.building_id)
  AND EXISTS (SELECT 1 FROM inventory_items i
    WHERE i.id = mr.item_id AND i.client_id = mr.client_id)
  AND (mr.warehouse_id IS NULL OR EXISTS (SELECT 1 FROM inventory_warehouses w
    WHERE w.id = mr.warehouse_id AND w.client_id = mr.client_id AND w.building_id = mr.building_id))`;

/** Alias r, including optional source warehouse restriction. */
export const RESERVATION_CHAIN_PREDICATE = `EXISTS (
  SELECT 1 FROM material_requests mr
  WHERE mr.id = r.material_request_id AND mr.client_id = r.client_id
    AND mr.building_id = r.building_id AND mr.item_id = r.item_id
    AND (mr.warehouse_id IS NULL OR mr.warehouse_id = r.warehouse_id)
    AND ${MATERIAL_CHAIN_PREDICATE}
) AND EXISTS (SELECT 1 FROM inventory_warehouses rw
  WHERE rw.id = r.warehouse_id AND rw.client_id = r.client_id AND rw.building_id = r.building_id)`;
