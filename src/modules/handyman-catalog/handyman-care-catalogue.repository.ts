import { getPool } from '../../database';
import type { CareWorkspacePrincipal } from '../handyman-care-workspace/care-workspace.service';
import { WORKSPACE_GRANTED_SCOPE_CTE } from '../handyman-care-workspace/care-workspace-scope.repository';

export type CareCatalogueVariant = { id: string; code: string; name: string; description: string | null };
export type CareCatalogueService = CareCatalogueVariant & { category: string; variants: CareCatalogueVariant[]; attributes: unknown[]; quantityRules: unknown[]; unitsOfMeasure: unknown[]; pricingMode: string | null; unknownValuePolicy: string };
export type CareCatalogueCategory = { category: string; serviceCount: number };
export type CareCatalogueProfile = {
  id: string; serviceCatalogId: string; serviceVariantId: string | null; inventoryItemId: string;
  specification: string | null; compatibility: string | null; typicalQuantity: number | null;
  commonality: string; customerMaterialOption: string;
  item: { id: string; code: string; name: string; uomId: string | null };
};
export type CatalogueSelection = {
  kind: 'services' | 'profiles'; profileId: string | null;
  afterId: string | null; limit: number; q: string | null;
  serviceCatalogId: string | null; serviceVariantId: string | null; buildingId: string | null;
};

/** Read adapter over existing catalogue masters. There is no property catalogue
 * master/override: property access derives Client, matching current customer
 * intake eligibility (ACTIVE service and same-Client ACTIVE child variant).
 * Material discovery additionally requires ACTIVE profile/item/parent references.
 * No pricing selection rules or administrative writes live here. */
async function readCatalogue(principal: CareWorkspacePrincipal, propertyId: string, selection: CatalogueSelection) {
  const services = selection.kind === 'services';
  const result = await getPool().query<{
    authenticated: boolean; accessible: boolean; evaluatedAt: Date; clientId: string | null;
    items: (CareCatalogueService | CareCatalogueProfile)[];
    categories: CareCatalogueCategory[];
  }>(`
    ${WORKSPACE_GRANTED_SCOPE_CTE}, services AS (
      SELECT sc.* FROM service_catalog sc JOIN granted p ON p.client_id = sc.client_id
      WHERE sc.status = 'ACTIVE'
    ), variants AS (
      SELECT v.* FROM handyman_service_variants v JOIN services sc
        ON sc.id = v.service_catalog_id AND sc.client_id = v.client_id
      WHERE v.status = 'ACTIVE'
    ), profiles AS (
      SELECT m.id, m.service_catalog_id AS "serviceCatalogId", m.service_variant_id AS "serviceVariantId",
        m.inventory_item_id AS "inventoryItemId", m.specification, m.compatibility,
        m.typical_quantity::float8 AS "typicalQuantity", m.commonality,
        m.customer_material_option AS "customerMaterialOption",
        jsonb_build_object('id', i.id, 'code', i.code, 'name', i.name, 'uomId', i.uom_id) AS item
      FROM handyman_common_material_profiles m
      JOIN services sc ON sc.id = m.service_catalog_id AND sc.client_id = m.client_id
      JOIN inventory_items i ON i.id = m.inventory_item_id AND i.client_id = m.client_id AND i.status = 'ACTIVE'
      WHERE m.status = 'ACTIVE'
        AND (m.service_variant_id IS NULL OR EXISTS (SELECT 1 FROM variants v
          WHERE v.id = m.service_variant_id AND v.service_catalog_id = m.service_catalog_id))
        AND ($8::uuid IS NULL OR m.service_catalog_id = $8)
        AND ($9::uuid IS NULL OR m.service_variant_id = $9 OR ($11::uuid IS NOT NULL AND m.service_variant_id IS NULL))
        AND ($11::uuid IS NULL OR m.id = $11)
        AND ($9::uuid IS NULL OR EXISTS (SELECT 1 FROM variants v WHERE v.id = $9 AND v.service_catalog_id = m.service_catalog_id))
    ), page AS (
      ${services ? `SELECT sc.id, sc.code, sc.name, sc.description, sc.category,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id', v.id, 'code', v.code, 'name', v.name,
          'description', v.description,
          'attributes', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'attributeId', a.id, 'code', a.code, 'name', a.name, 'dataType', a.data_type,
            'value', COALESCE(va.value_text, va.value_number::text), 'unit', a.unit)
            ORDER BY a.sort_order, a.code)
            FROM handyman_service_variant_attributes va
            JOIN handyman_service_attributes a ON a.id = va.attribute_id
              AND a.client_id = va.client_id AND a.service_catalog_id = sc.id
            WHERE va.service_variant_id = v.id AND va.client_id = sc.client_id
              AND va.status = 'ACTIVE' AND a.status = 'ACTIVE'), '[]'::jsonb)
          ) ORDER BY v.id) FROM variants v WHERE v.service_catalog_id = sc.id), '[]'::jsonb) AS variants,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id', a.id, 'code', a.code,
          'name', a.name, 'description', a.description, 'dataType', a.data_type,
          'unit', a.unit, 'required', a.required, 'allowFreeValue', a.allow_free_value,
          'allowedValues', a.allowed_values) ORDER BY a.sort_order, a.code)
          FROM handyman_service_attributes a WHERE a.service_catalog_id = sc.id
            AND a.client_id = sc.client_id AND a.status = 'ACTIVE'), '[]'::jsonb) AS attributes,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('minimum', r.min_quantity,
          'maximum', r.max_quantity, 'serviceVariantId', r.service_variant_id)
          ORDER BY r.min_quantity NULLS FIRST, r.max_quantity NULLS LAST)
          FROM handyman_service_price_rules r WHERE r.service_catalog_id = sc.id
            AND r.client_id = sc.client_id AND r.status = 'ACTIVE'), '[]'::jsonb) AS "quantityRules",
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id', u.id, 'code', u.code,
          'name', u.name, 'symbol', u.symbol, 'category', u.category) ORDER BY u.code)
          FROM units_of_measure u WHERE u.client_id = sc.client_id AND u.status = 'ACTIVE'), '[]'::jsonb) AS "unitsOfMeasure",
        (SELECT cp.pricing_mode FROM handyman_service_commercial_profiles cp
          WHERE cp.service_catalog_id = sc.id AND cp.client_id = sc.client_id AND cp.status = 'ACTIVE' LIMIT 1) AS "pricingMode",
        'Unrecognized or incomplete technical facts are retained for inspection; quote resolution reports configured validation failures.'::text AS "unknownValuePolicy"
        FROM services sc WHERE ($5::uuid IS NULL OR sc.id > $5)
          AND ($7::text IS NULL OR strpos(lower(sc.code), lower($7)) > 0 OR strpos(lower(sc.name), lower($7)) > 0)
        ORDER BY sc.id LIMIT $6`
      : `SELECT * FROM profiles WHERE $7::text IS NULL AND ($5::uuid IS NULL OR id > $5) ORDER BY id LIMIT $6`}
    )
    SELECT EXISTS(SELECT 1 FROM authority) AS authenticated,
      (EXISTS(SELECT 1 FROM granted)
        AND ($8::uuid IS NULL OR EXISTS(SELECT 1 FROM services WHERE id = $8))
        AND ($9::uuid IS NULL OR EXISTS(SELECT 1 FROM variants WHERE id = $9 AND ($8::uuid IS NULL OR service_catalog_id = $8)))
        AND ($10::uuid IS NULL OR EXISTS(SELECT 1 FROM buildings b JOIN granted p ON p.id = b.property_id WHERE b.id = $10 AND b.status = 'ACTIVE'))
        AND ($11::uuid IS NULL OR EXISTS(SELECT 1 FROM profiles))) AS accessible,
      (SELECT client_id FROM granted LIMIT 1) AS "clientId", statement_timestamp() AS "evaluatedAt",
      COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY page.id) FROM page), '[]'::jsonb) AS items,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('category', grouped.category,
        'serviceCount', grouped.service_count) ORDER BY grouped.category)
        FROM (SELECT sc.category, count(*)::int AS service_count FROM services sc
          GROUP BY sc.category) grouped), '[]'::jsonb) AS categories` ,
    [principal.sessionId, principal.careActorId, principal.integrationId, propertyId,
      selection.afterId, selection.limit + 1, selection.q, selection.serviceCatalogId,
      selection.serviceVariantId, selection.buildingId, selection.profileId]);
  return result.rows[0];
}

export const handymanCareCatalogueRepository = { readCatalogue };
