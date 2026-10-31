import type { PoolClient } from 'pg';
import { getPool } from '../../database';

/**
 * CR-HM-BE-CARE-CATALOG-METADATA-01 PART 06 — Building-session catalogue
 * metadata read adapter.
 *
 * WHY A NEW READER: the existing Care catalogue projection
 * (`handyman-care-catalogue.repository.ts`) is bound to the Care WORKSPACE
 * principal (`hcw_` session + property grant). The Building session is a
 * different credential (Backend Bearer session + `handyman.care.building` +
 * exact Building assignment), and PART 04's structured intake runs on it.
 * Re-implementing the workspace grant check here would be a second
 * authorization engine; substituting the workspace credential would replace
 * Building-session authentication. So this reader is a THIN, client-scoped
 * projection over the SAME masters, with the scope decided by the caller.
 *
 * SCOPE LAW: every statement is keyed by the `clientId` the caller derived
 * server-side from `resolveBuildingCareAuthority` (Building -> Property ->
 * Client) plus the requested service id. No caller-supplied Client, property
 * or tenant participates, so a foreign-Client service is indistinguishable
 * from an absent one.
 *
 * COMMERCIAL LAW: this projection deliberately returns NO commercial field —
 * no `pricingMode`, no price rule id/`ruleCode`, no `priceCatalogEntryId`, no
 * `priceBasis`, no amount, no currency. Only the governed QUANTITY bounds of
 * ACTIVE price rules are projected (plain min/max), because they are the
 * quantity constraint the intake form must respect and because they reveal
 * no price. Reported UOM is NOT the quotation pricing UOM.
 */

export type CareCatalogAttributeRecord = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  dataType: 'NUMBER' | 'TEXT' | 'ENUM' | 'BOOLEAN';
  unit: string | null;
  required: boolean;
  allowFreeValue: boolean;
  allowedValues: { code: string; label: string }[];
  sortOrder: number;
  status: 'ACTIVE';
};

export type CareCatalogVariantAttributeRecord = {
  attributeId: string;
  code: string;
  name: string;
  dataType: 'NUMBER' | 'TEXT' | 'ENUM' | 'BOOLEAN';
  unit: string | null;
  valueText: string | null;
  valueNumber: number | null;
};

export type CareCatalogVariantRecord = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: 'ACTIVE';
  inheritedAttributeValues: CareCatalogVariantAttributeRecord[];
};

export type CareCatalogQuantityConstraintRecord = {
  serviceVariantId: string | null;
  minimum: number | null;
  maximum: number | null;
};

export type CareCatalogUomRecord = {
  id: string;
  code: string;
  name: string;
  symbol: string;
  category: string;
};

export type CareCatalogServiceMetadataRecord = {
  service: {
    id: string;
    code: string;
    name: string;
    description: string | null;
    category: string;
    status: 'ACTIVE';
  };
  attributes: CareCatalogAttributeRecord[];
  variants: CareCatalogVariantRecord[];
  quantityConstraints: CareCatalogQuantityConstraintRecord[];
  unitsOfMeasure: CareCatalogUomRecord[];
};

/**
 * One ACTIVE service of the Client with its ACTIVE technical attribute
 * definitions, its ACTIVE variants and the attribute values each variant
 * INHERITS, the ACTIVE quantity bounds and the ACTIVE Client-owned UOMs.
 *
 * A single statement keeps the read atomic and lets PostgreSQL fold the
 * correlated sub-selects over the client-scoped rows.
 */
async function findServiceMetadata(
  clientId: string,
  serviceCatalogId: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<CareCatalogServiceMetadataRecord | null> {
  const result = await executor.query<CareCatalogServiceMetadataRecord>(
    `WITH svc AS (
       SELECT sc.id, sc.code, sc.name, sc.description, sc.category, sc.status
         FROM service_catalog sc
        WHERE sc.id = $2 AND sc.client_id = $1 AND sc.status = 'ACTIVE'
     )
     SELECT jsonb_build_object(
              'id', svc.id, 'code', svc.code, 'name', svc.name,
              'description', svc.description, 'category', svc.category,
              'status', svc.status) AS service,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'id', a.id, 'code', a.code, 'name', a.name,
                'description', a.description, 'dataType', a.data_type,
                'unit', a.unit, 'required', a.required,
                'allowFreeValue', a.allow_free_value,
                'allowedValues', a.allowed_values,
                'sortOrder', a.sort_order, 'status', a.status)
                ORDER BY a.sort_order, a.code)
                FROM handyman_service_attributes a
               WHERE a.client_id = $1 AND a.service_catalog_id = svc.id
                 AND a.status = 'ACTIVE'), '[]'::jsonb) AS attributes,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'id', v.id, 'code', v.code, 'name', v.name,
                'description', v.description, 'status', v.status,
                'inheritedAttributeValues', COALESCE((
                  SELECT jsonb_agg(jsonb_build_object(
                    'attributeId', a2.id, 'code', a2.code, 'name', a2.name,
                    'dataType', a2.data_type, 'unit', a2.unit,
                    'valueText', va.value_text,
                    'valueNumber', va.value_number::float8)
                    ORDER BY a2.sort_order, a2.code)
                    FROM handyman_service_variant_attributes va
                    JOIN handyman_service_attributes a2
                      ON a2.id = va.attribute_id
                     AND a2.client_id = $1
                     AND a2.service_catalog_id = svc.id
                     AND a2.status = 'ACTIVE'
                   WHERE va.client_id = $1
                     AND va.service_variant_id = v.id
                     AND va.status = 'ACTIVE'), '[]'::jsonb))
                ORDER BY v.code, v.id)
                FROM handyman_service_variants v
               WHERE v.client_id = $1 AND v.service_catalog_id = svc.id
                 AND v.status = 'ACTIVE'), '[]'::jsonb) AS variants,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'serviceVariantId', r.service_variant_id,
                'minimum', r.min_quantity::float8,
                'maximum', r.max_quantity::float8)
                ORDER BY r.service_variant_id NULLS FIRST, r.id)
                FROM handyman_service_price_rules r
               WHERE r.client_id = $1 AND r.service_catalog_id = svc.id
                 AND r.status = 'ACTIVE'), '[]'::jsonb) AS "quantityConstraints",
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'id', u.id, 'code', u.code, 'name', u.name,
                'symbol', u.symbol, 'category', u.category)
                ORDER BY u.code)
                FROM units_of_measure u
               WHERE u.client_id = $1 AND u.status = 'ACTIVE'), '[]'::jsonb)
              AS "unitsOfMeasure"
       FROM svc`,
    [clientId, serviceCatalogId],
  );
  return result.rows[0] ?? null;
}

export const handymanCareCatalogMetadataRepository = {
  findServiceMetadata,
};
