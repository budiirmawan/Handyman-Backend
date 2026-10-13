# CR-HM-SEC-03 PART04 — focused item-list EXPLAIN evidence

Date: 2026-10-10 (Asia/Jakarta). Runtime reviewed at
`beb4b28eeae32c367ab8c91cdc6e04e97ce8cb40`.

## Method and limitations

Disposable PostgreSQL 18.4; existing migrations/indexes only; no Docker,
index creation, schema-file changes or production database access. Fixture
inserts and ANALYZE ran in one transaction; ROLLBACK removed the inserts.
Existing small security-test fixtures were also present. This is a warm-cache,
synthetic local observation, not a production SLA or proof at arbitrary scale.

Added: 4 Clients, 40 Buildings (10 per Client), 40 Warehouses, 800 Items
(200 per Client), 4,000 Purchase Requests (100 per Building), 80,000 Material
Requests (20 per PR). Every second request within a PR references that Client's
hot item (10,000 hot lines per Client). Other item assignments cycle across
199 items; the tested selective item has 51 lines across its Client. Every
fifth line is CANCELLED, the remainder OPEN; every third has a null Warehouse.
Creation times are deterministic. Three hot rows have deliberately inconsistent
PR, Warehouse or Client ownership using otherwise valid independent FKs.
The scoped query excludes all three from the broad hot-item result.

Captured the SQL/parameters actually emitted by
`materialRequestRepository.listByItem`, then executed on the transaction's
connection. Six cases, three `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` runs per
case, followed by one text-format run per case. UUIDs below are disposable
fixture identifiers, not production identifiers. The text run is separate from
the three timing samples and may differ slightly.

Settings: work_mem 4 MB; shared_buffers 128 MB; effective_cache_size 4 GB;
random_page_cost 4. Default sandbox planner settings, no forced access paths.

## Observed results

| Case | Exact scope pairs | Returned rows | Execution ms, three JSON samples | Planning ms, three JSON samples |
|---|---:|---:|---|---|
| hot / 1 building | 1 | 997 | 3.552, 3.507, 3.391 | 1.571, 0.953, 0.922 |
| hot / 5 buildings | 5 | 4997 | 16.780, 16.615, 16.542 | 0.906, 0.916, 0.908 |
| hot / 40 buildings | 40 | 9997 | 33.701, 34.953, 34.340 | 0.943, 1.025, 1.018 |
| selective / 1 building | 1 | 6 | 0.363, 0.291, 0.272 | 1.029, 0.955, 0.940 |
| hot + status / 1 building | 1 | 798 | 6.878, 6.480, 6.047 | 0.948, 1.009, 0.999 |
| hot + PR / 1 building | 1 | 7 | 0.201, 0.271, 0.182 | 0.734, 0.694, 0.727 |

- Existing item/Building/Client/PR bitmap indexes and parent PK probes were
  used; no sequential scan of `material_requests` in these six cases. The small
  Warehouse sequential scan (60 total rows in this fixture state) is hashed
  once; it is not evidence for a new Warehouse index.
- All observed sorts were in-memory quicksort (25–1,962 kB). Measured warm JSON
  runs reported no shared reads or temporary I/O.
- Top estimate stayed at **1 row**, versus up to **9,997 actual rows**.
  `jsonb_to_recordset` estimated 100 scope rows versus actual 1/5/40. Scope
  width increases bitmap work and parent ownership probes; the 40-pair scope
  spans four Clients but item ownership restricts effective Building scans to
  the item's 10 Buildings.
- OPEN-filter planning chose `material_requests_rfq_scope_unique` on nonleading
  Client/Building columns (1,086 index-buffer hits), whereas unfiltered cases
  use the Building index (23 hits for its bitmap scan). The status-filter case
  was slower despite fewer result rows. This warrants follow-up, not a claim
  that status filtering always improves performance.

## Index recommendation / unresolved plan concerns

**No index migration recommended for immediate application.** Existing indexes
suffice for these local fixtures; no comparative candidate-index experiment
was authorized or performed. An evidence-backed *future evaluation candidate*
is a composite Item + exact Client/Building index, comparing status/order
variants, to reduce repeated bitmap intersections and the observed nonleading
index work. This is not a proven improvement or a DDL proposal for this change.

Before authorizing any migration, compare with production-like cardinality,
skew and statistics on the deployed PostgreSQL version, cold-cache behavior,
prepared/generic plans, larger scope sizes, write/storage overhead and stable
ordering requirements. Row-estimate errors remain unresolved. There is no
pagination here: growth of visible history/output can dominate query and
serialization cost. These fixtures do not certify that scaling boundary.

## Existing MR indexes (observation, not new DDL)

```sql
CREATE INDEX material_requests_building_idx ON public.material_requests USING btree (building_id, status, created_at);
CREATE INDEX material_requests_client_idx ON public.material_requests USING btree (client_id, status);
CREATE INDEX material_requests_item_idx ON public.material_requests USING btree (item_id, status);
CREATE UNIQUE INDEX material_requests_pkey ON public.material_requests USING btree (id);
CREATE INDEX material_requests_purchase_request_idx ON public.material_requests USING btree (purchase_request_id, status);
CREATE UNIQUE INDEX material_requests_rfq_scope_unique ON public.material_requests USING btree (id, client_id, building_id, purchase_request_id);
CREATE INDEX material_requests_warehouse_idx ON public.material_requests USING btree (warehouse_id, status);
```

## Captured repository SQL

```sql
SELECT
  id,
  client_id AS "clientId",
  building_id AS "buildingId",
  purchase_request_id AS "purchaseRequestId",
  item_id AS "itemId",
  warehouse_id AS "warehouseId",
  quantity,
  approved_quantity AS "approvedQuantity",
  approved_at AS "approvedAt",
  approved_by_user_id AS "approvedByUserId",
  uom_id AS "uomId",
  required_date AS "requiredDate",
  notes,
  status,
  requested_by_user_id AS "requestedByUserId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
 FROM material_requests mr
     WHERE mr.item_id = $1 AND EXISTS (
       SELECT 1 FROM jsonb_to_recordset($2::jsonb)
         AS authorized("clientId" uuid, "buildingId" uuid)
       WHERE authorized."clientId" = mr.client_id
         AND authorized."buildingId" = mr.building_id
     ) AND EXISTS (
       SELECT 1 FROM purchase_requests pr
       WHERE pr.id = mr.purchase_request_id
         AND pr.client_id = mr.client_id AND pr.building_id = mr.building_id
     ) AND EXISTS (
       SELECT 1 FROM inventory_items i
       WHERE i.id = mr.item_id AND i.client_id = mr.client_id
     ) AND (mr.warehouse_id IS NULL OR EXISTS (
       SELECT 1 FROM inventory_warehouses w
       WHERE w.id = mr.warehouse_id
         AND w.client_id = mr.client_id AND w.building_id = mr.building_id
     ))
     ORDER BY mr.created_at DESC, mr.id DESC
```

The status case inserts `AND mr.status = $3` before ORDER BY; the PR case
inserts `AND mr.purchase_request_id = $3`. Parameters and plans follow.

### hot / 1 building

Parameters ($1 item, $2 JSON exact pairs, optional $3 filter):

```json
[
  "05705be6-bd90-4ca0-ac24-0ab6ba31c272",
  "[{\"clientId\":\"dfdba920-0edb-46b5-ad7f-3519e30a896c\",\"buildingId\":\"43626b8c-cad3-4190-84d6-40e2bb954a82\"}]"
]
```

```text
Sort  (cost=392.87..392.87 rows=1 width=223) (actual time=3.190..3.242 rows=997.00 loops=1)
  Sort Key: mr.created_at DESC, mr.id DESC
  Sort Method: quicksort  Memory: 182kB
  Buffers: shared hit=3095
  ->  Nested Loop  (cost=236.92..392.86 rows=1 width=223) (actual time=0.914..2.793 rows=997.00 loops=1)
        Join Filter: ((authorized."clientId" = pr.client_id) AND (authorized."buildingId" = pr.building_id))
        Buffers: shared hit=3095
        ->  Nested Loop  (cost=236.64..366.77 rows=67 width=271) (actual time=0.855..1.391 rows=998.00 loops=1)
              Buffers: shared hit=101
              ->  Nested Loop  (cost=1.78..12.04 rows=1 width=64) (actual time=0.015..0.017 rows=1.00 loops=1)
                    Join Filter: (authorized."clientId" = i.client_id)
                    Buffers: shared hit=3
                    ->  Index Only Scan using inventory_items_price_scope_unique on inventory_items i  (cost=0.28..8.29 rows=1 width=32) (actual time=0.005..0.006 rows=1.00 loops=1)
                          Index Cond: (id = '05705be6-bd90-4ca0-ac24-0ab6ba31c272'::uuid)
                          Heap Fetches: 1
                          Index Searches: 1
                          Buffers: shared hit=3
                    ->  HashAggregate  (cost=1.50..2.50 rows=100 width=32) (actual time=0.009..0.009 rows=1.00 loops=1)
                          Group Key: authorized."clientId", authorized."buildingId"
                          Batches: 1  Memory Usage: 32kB
                          ->  Function Scan on jsonb_to_recordset authorized  (cost=0.00..1.00 rows=100 width=32) (actual time=0.005..0.006 rows=1.00 loops=1)
              ->  Bitmap Heap Scan on material_requests mr  (cost=234.86..354.58 rows=15 width=223) (actual time=0.838..1.169 rows=998.00 loops=1)
                    Recheck Cond: ((building_id = authorized."buildingId") AND (client_id = authorized."clientId") AND (item_id = '05705be6-bd90-4ca0-ac24-0ab6ba31c272'::uuid))
                    Filter: ((warehouse_id IS NULL) OR (ANY ((warehouse_id = (hashed SubPlan 2).col1) AND (client_id = (hashed SubPlan 2).col2) AND (building_id = (hashed SubPlan 2).col3))))
                    Rows Removed by Filter: 1
                    Heap Blocks: exact=45
                    Buffers: shared hit=98
                    ->  BitmapAnd  (cost=234.86..234.86 rows=22 width=0) (actual time=0.829..0.829 rows=0.00 loops=1)
                          Buffers: shared hit=51
                          ->  Bitmap Index Scan on material_requests_building_idx  (cost=0.00..46.87 rows=1740 width=0) (actual time=0.058..0.058 rows=2000.00 loops=1)
                                Index Cond: (building_id = authorized."buildingId")
                                Index Searches: 1
                                Buffers: shared hit=23
                          ->  Bitmap Index Scan on material_requests_client_idx  (cost=0.00..63.23 rows=8002 width=0) (actual time=0.492..0.492 rows=19999.00 loops=1)
                                Index Cond: (client_id = authorized."clientId")
                                Index Searches: 1
                                Buffers: shared hit=18
                          ->  Bitmap Index Scan on material_requests_item_idx  (cost=0.00..122.59 rows=9906 width=0) (actual time=0.274..0.274 rows=10000.00 loops=1)
                                Index Cond: (item_id = '05705be6-bd90-4ca0-ac24-0ab6ba31c272'::uuid)
                                Index Searches: 1
                                Buffers: shared hit=10
                    SubPlan 2
                      ->  Seq Scan on inventory_warehouses w  (cost=0.00..2.60 rows=60 width=48) (actual time=0.003..0.010 rows=60.00 loops=1)
                            Buffers: shared hit=2
        ->  Index Scan using purchase_requests_pkey on purchase_requests pr  (cost=0.28..0.37 rows=1 width=48) (actual time=0.001..0.001 rows=1.00 loops=998)
              Index Cond: (id = mr.purchase_request_id)
              Filter: ((mr.client_id = client_id) AND (mr.building_id = building_id))
              Rows Removed by Filter: 0
              Index Searches: 998
              Buffers: shared hit=2994
Planning:
  Buffers: shared hit=57
Planning Time: 0.953 ms
Execution Time: 3.318 ms
```

### hot / 5 buildings

Parameters ($1 item, $2 JSON exact pairs, optional $3 filter):

```json
[
  "05705be6-bd90-4ca0-ac24-0ab6ba31c272",
  "[{\"clientId\":\"dfdba920-0edb-46b5-ad7f-3519e30a896c\",\"buildingId\":\"43626b8c-cad3-4190-84d6-40e2bb954a82\"},{\"clientId\":\"dfdba920-0edb-46b5-ad7f-3519e30a896c\",\"buildingId\":\"ebbf2cbf-612a-48d6-82d5-192c30d1e75f\"},{\"clientId\":\"dfdba920-0edb-46b5-ad7f-3519e30a896c\",\"buildingId\":\"147a359d-1dad-48e0-9090-d2df4bed1a48\"},{\"clientId\":\"dfdba920-0edb-46b5-ad7f-3519e30a896c\",\"buildingId\":\"b45be359-de3d-4546-a11b-b3b3cea73f65\"},{\"clientId\":\"dfdba920-0edb-46b5-ad7f-3519e30a896c\",\"buildingId\":\"dc50b59b-26a3-45ce-9b97-4c1b72cb8484\"}]"
]
```

```text
Sort  (cost=392.87..392.87 rows=1 width=223) (actual time=15.923..16.167 rows=4997.00 loops=1)
  Sort Key: mr.created_at DESC, mr.id DESC
  Sort Method: quicksort  Memory: 981kB
  Buffers: shared hit=15475
  ->  Nested Loop  (cost=236.92..392.86 rows=1 width=223) (actual time=0.892..13.874 rows=4997.00 loops=1)
        Join Filter: ((authorized."clientId" = pr.client_id) AND (authorized."buildingId" = pr.building_id))
        Buffers: shared hit=15475
        ->  Nested Loop  (cost=236.64..366.77 rows=67 width=271) (actual time=0.886..6.737 rows=4998.00 loops=1)
              Buffers: shared hit=481
              ->  Nested Loop  (cost=1.78..12.04 rows=1 width=64) (actual time=0.021..0.029 rows=5.00 loops=1)
                    Join Filter: (authorized."clientId" = i.client_id)
                    Buffers: shared hit=3
                    ->  Index Only Scan using inventory_items_price_scope_unique on inventory_items i  (cost=0.28..8.29 rows=1 width=32) (actual time=0.006..0.006 rows=1.00 loops=1)
                          Index Cond: (id = '05705be6-bd90-4ca0-ac24-0ab6ba31c272'::uuid)
                          Heap Fetches: 1
                          Index Searches: 1
                          Buffers: shared hit=3
                    ->  HashAggregate  (cost=1.50..2.50 rows=100 width=32) (actual time=0.014..0.019 rows=5.00 loops=1)
                          Group Key: authorized."clientId", authorized."buildingId"
                          Batches: 1  Memory Usage: 32kB
                          ->  Function Scan on jsonb_to_recordset authorized  (cost=0.00..1.00 rows=100 width=32) (actual time=0.010..0.010 rows=5.00 loops=1)
              ->  Bitmap Heap Scan on material_requests mr  (cost=234.86..354.58 rows=15 width=223) (actual time=0.853..1.148 rows=999.60 loops=5)
                    Recheck Cond: ((building_id = authorized."buildingId") AND (client_id = authorized."clientId") AND (item_id = '05705be6-bd90-4ca0-ac24-0ab6ba31c272'::uuid))
                    Filter: ((warehouse_id IS NULL) OR (ANY ((warehouse_id = (hashed SubPlan 2).col1) AND (client_id = (hashed SubPlan 2).col2) AND (building_id = (hashed SubPlan 2).col3))))
                    Rows Removed by Filter: 0
                    Heap Blocks: exact=223
                    Buffers: shared hit=478
                    ->  BitmapAnd  (cost=234.86..234.86 rows=22 width=0) (actual time=0.845..0.846 rows=0.00 loops=5)
                          Buffers: shared hit=253
                          ->  Bitmap Index Scan on material_requests_building_idx  (cost=0.00..46.87 rows=1740 width=0) (actual time=0.060..0.060 rows=2000.00 loops=5)
                                Index Cond: (building_id = authorized."buildingId")
                                Index Searches: 5
                                Buffers: shared hit=113
                          ->  Bitmap Index Scan on material_requests_client_idx  (cost=0.00..63.23 rows=8002 width=0) (actual time=0.498..0.498 rows=19999.00 loops=5)
                                Index Cond: (client_id = authorized."clientId")
                                Index Searches: 5
                                Buffers: shared hit=90
                          ->  Bitmap Index Scan on material_requests_item_idx  (cost=0.00..122.59 rows=9906 width=0) (actual time=0.281..0.281 rows=10000.00 loops=5)
                                Index Cond: (item_id = '05705be6-bd90-4ca0-ac24-0ab6ba31c272'::uuid)
                                Index Searches: 5
                                Buffers: shared hit=50
                    SubPlan 2
                      ->  Seq Scan on inventory_warehouses w  (cost=0.00..2.60 rows=60 width=48) (actual time=0.004..0.010 rows=60.00 loops=1)
                            Buffers: shared hit=2
        ->  Index Scan using purchase_requests_pkey on purchase_requests pr  (cost=0.28..0.37 rows=1 width=48) (actual time=0.001..0.001 rows=1.00 loops=4998)
              Index Cond: (id = mr.purchase_request_id)
              Filter: ((mr.client_id = client_id) AND (mr.building_id = building_id))
              Rows Removed by Filter: 0
              Index Searches: 4998
              Buffers: shared hit=14994
Planning:
  Buffers: shared hit=57
Planning Time: 0.977 ms
Execution Time: 16.370 ms
```

### hot / 40 buildings

Parameters ($1 item, $2 JSON exact pairs, optional $3 filter):

```json
[
  "05705be6-bd90-4ca0-ac24-0ab6ba31c272",
  "[{\"clientId\":\"dfdba920-0edb-46b5-ad7f-3519e30a896c\",\"buildingId\":\"43626b8c-cad3-4190-84d6-40e2bb954a82\"},{\"clientId\":\"dfdba920-0edb-46b5-ad7f-3519e30a896c\",\"buildingId\":\"ebbf2cbf-612a-48d6-82d5-192c30d1e75f\"},{\"clientId\":\"dfdba920-0edb-46b5-ad7f-3519e30a896c\",\"buildingId\":\"147a359d-1dad-48e0-9090-d2df4bed1a48\"},{\"clientId\":\"dfdba920-0edb-46b5-ad7f-3519e30a896c\",\"buildingId\":\"b45be359-de3d-4546-a11b-b3b3cea73f65\"},{\"clientId\":\"dfdba920-0edb-46b5-ad7f-3519e30a896c\",\"buildingId\":\"dc50b59b-26a3-45ce-9b97-4c1b72cb8484\"},{\"clientId\":\"dfdba920-0edb-46b5-ad7f-3519e30a896c\",\"buildingId\":\"fb379f29-32f7-4d79-a4eb-a72543f50caf\"},{\"clientId\":\"dfdba920-0edb-46b5-ad7f-3519e30a896c\",\"buildingId\":\"fc906456-4b38-4ad6-89df-8be4f645c426\"},{\"clientId\":\"dfdba920-0edb-46b5-ad7f-3519e30a896c\",\"buildingId\":\"10c6fd5b-28a8-49ac-9fe5-fd246c6df5e8\"},{\"clientId\":\"dfdba920-0edb-46b5-ad7f-3519e30a896c\",\"buildingId\":\"5223a521-eea2-41c1-8add-925ad2eb0061\"},{\"clientId\":\"dfdba920-0edb-46b5-ad7f-3519e30a896c\",\"buildingId\":\"f22988f3-54d2-4357-82fe-4fc3e618fdb3\"},{\"clientId\":\"6aca76a9-96f3-4eba-82fb-4c933cde7872\",\"buildingId\":\"42e363cd-cbb0-48dc-9d6b-66c1b2deafa8\"},{\"clientId\":\"6aca76a9-96f3-4eba-82fb-4c933cde7872\",\"buildingId\":\"b492da19-40a2-4c88-8490-33655db895a3\"},{\"clientId\":\"6aca76a9-96f3-4eba-82fb-4c933cde7872\",\"buildingId\":\"1d74e785-6e65-4241-9ae8-30c92d54d9cd\"},{\"clientId\":\"6aca76a9-96f3-4eba-82fb-4c933cde7872\",\"buildingId\":\"e4526abf-2b7f-4699-9f1e-9882af6ba203\"},{\"clientId\":\"6aca76a9-96f3-4eba-82fb-4c933cde7872\",\"buildingId\":\"7b410412-4b50-4f13-b302-f5d2597f9f69\"},{\"clientId\":\"6aca76a9-96f3-4eba-82fb-4c933cde7872\",\"buildingId\":\"f9985750-f911-4b0a-8158-6256ef81093b\"},{\"clientId\":\"6aca76a9-96f3-4eba-82fb-4c933cde7872\",\"buildingId\":\"4d846e23-434a-44a6-b39a-1d76c7be29a1\"},{\"clientId\":\"6aca76a9-96f3-4eba-82fb-4c933cde7872\",\"buildingId\":\"798d8075-791b-400a-b0e5-2c7967766968\"},{\"clientId\":\"6aca76a9-96f3-4eba-82fb-4c933cde7872\",\"buildingId\":\"c9e259e7-dc8b-41d5-8f1c-90d6519064a5\"},{\"clientId\":\"6aca76a9-96f3-4eba-82fb-4c933cde7872\",\"buildingId\":\"99ec8cd5-c9f5-48be-bf75-0792ca2eb66d\"},{\"clientId\":\"57c3253c-abae-4179-a544-86cfece8412d\",\"buildingId\":\"e68128f0-f6a5-4cd5-9fa9-368b976d106a\"},{\"clientId\":\"57c3253c-abae-4179-a544-86cfece8412d\",\"buildingId\":\"3bafa59a-441a-4b99-b3c6-32a6cce856d1\"},{\"clientId\":\"57c3253c-abae-4179-a544-86cfece8412d\",\"buildingId\":\"2ec9a8ba-b984-4b36-81df-676398e5b1a4\"},{\"clientId\":\"57c3253c-abae-4179-a544-86cfece8412d\",\"buildingId\":\"a63236bc-42b0-4ecb-835e-2989e5eb6be7\"},{\"clientId\":\"57c3253c-abae-4179-a544-86cfece8412d\",\"buildingId\":\"93cb4ff7-0485-4dbe-bd12-27884f01ee43\"},{\"clientId\":\"57c3253c-abae-4179-a544-86cfece8412d\",\"buildingId\":\"f40707c3-f350-4a2a-9be5-ba4dd3145220\"},{\"clientId\":\"57c3253c-abae-4179-a544-86cfece8412d\",\"buildingId\":\"b9a314db-a6a9-4127-acbb-a3d6ce9e9477\"},{\"clientId\":\"57c3253c-abae-4179-a544-86cfece8412d\",\"buildingId\":\"b8f16c36-8290-46b9-9c38-282f605ac4f2\"},{\"clientId\":\"57c3253c-abae-4179-a544-86cfece8412d\",\"buildingId\":\"7a10c9d4-b203-44c0-a008-5096926c0566\"},{\"clientId\":\"57c3253c-abae-4179-a544-86cfece8412d\",\"buildingId\":\"d1b406c6-28d1-479a-bb80-34401705060e\"},{\"clientId\":\"70e72de4-ccf6-422c-aaa1-74a87258d36a\",\"buildingId\":\"4be9542f-e97d-4ff1-af78-604d282a6589\"},{\"clientId\":\"70e72de4-ccf6-422c-aaa1-74a87258d36a\",\"buildingId\":\"da3cac3e-d103-4cc2-8998-8a9fa58ca402\"},{\"clientId\":\"70e72de4-ccf6-422c-aaa1-74a87258d36a\",\"buildingId\":\"4a390914-6325-45f2-a0d6-4f0364ed401e\"},{\"clientId\":\"70e72de4-ccf6-422c-aaa1-74a87258d36a\",\"buildingId\":\"df8d8a11-cd7c-44a3-84c9-4e79fc60ddad\"},{\"clientId\":\"70e72de4-ccf6-422c-aaa1-74a87258d36a\",\"buildingId\":\"fdc7e275-a24f-4bc9-826a-ace4f59fbf40\"},{\"clientId\":\"70e72de4-ccf6-422c-aaa1-74a87258d36a\",\"buildingId\":\"8e6723b7-2944-4656-9496-d785b1fe43ea\"},{\"clientId\":\"70e72de4-ccf6-422c-aaa1-74a87258d36a\",\"buildingId\":\"5ba006dd-b0fe-467f-a705-9a9dab35bf7e\"},{\"clientId\":\"70e72de4-ccf6-422c-aaa1-74a87258d36a\",\"buildingId\":\"fb295a58-d651-4006-aee8-e536655b6220\"},{\"clientId\":\"70e72de4-ccf6-422c-aaa1-74a87258d36a\",\"buildingId\":\"4f9785da-3028-4e8d-a35f-f15991133f60\"},{\"clientId\":\"70e72de4-ccf6-422c-aaa1-74a87258d36a\",\"buildingId\":\"2b39465c-3e74-48c5-9186-9c2e25af3d19\"}]"
]
```

```text
Sort  (cost=392.87..392.87 rows=1 width=223) (actual time=32.888..33.457 rows=9997.00 loops=1)
  Sort Key: mr.created_at DESC, mr.id DESC
  Sort Method: quicksort  Memory: 1962kB
  Buffers: shared hit=30944
  ->  Nested Loop  (cost=236.92..392.86 rows=1 width=223) (actual time=0.966..28.574 rows=9997.00 loops=1)
        Join Filter: ((authorized."clientId" = pr.client_id) AND (authorized."buildingId" = pr.building_id))
        Buffers: shared hit=30944
        ->  Nested Loop  (cost=236.64..366.77 rows=67 width=271) (actual time=0.959..14.188 rows=9998.00 loops=1)
              Buffers: shared hit=950
              ->  Nested Loop  (cost=1.78..12.04 rows=1 width=64) (actual time=0.070..0.092 rows=10.00 loops=1)
                    Join Filter: (authorized."clientId" = i.client_id)
                    Rows Removed by Join Filter: 30
                    Buffers: shared hit=3
                    ->  Index Only Scan using inventory_items_price_scope_unique on inventory_items i  (cost=0.28..8.29 rows=1 width=32) (actual time=0.007..0.008 rows=1.00 loops=1)
                          Index Cond: (id = '05705be6-bd90-4ca0-ac24-0ab6ba31c272'::uuid)
                          Heap Fetches: 1
                          Index Searches: 1
                          Buffers: shared hit=3
                    ->  HashAggregate  (cost=1.50..2.50 rows=100 width=32) (actual time=0.062..0.076 rows=40.00 loops=1)
                          Group Key: authorized."clientId", authorized."buildingId"
                          Batches: 1  Memory Usage: 32kB
                          ->  Function Scan on jsonb_to_recordset authorized  (cost=0.00..1.00 rows=100 width=32) (actual time=0.046..0.049 rows=40.00 loops=1)
              ->  Bitmap Heap Scan on material_requests mr  (cost=234.86..354.58 rows=15 width=223) (actual time=0.871..1.209 rows=999.80 loops=10)
                    Recheck Cond: ((building_id = authorized."buildingId") AND (client_id = authorized."clientId") AND (item_id = '05705be6-bd90-4ca0-ac24-0ab6ba31c272'::uuid))
                    Filter: ((warehouse_id IS NULL) OR (ANY ((warehouse_id = (hashed SubPlan 2).col1) AND (client_id = (hashed SubPlan 2).col2) AND (building_id = (hashed SubPlan 2).col3))))
                    Rows Removed by Filter: 0
                    Heap Blocks: exact=444
                    Buffers: shared hit=947
                    ->  BitmapAnd  (cost=234.86..234.86 rows=22 width=0) (actual time=0.863..0.863 rows=0.00 loops=10)
                          Buffers: shared hit=501
                          ->  Bitmap Index Scan on material_requests_building_idx  (cost=0.00..46.87 rows=1740 width=0) (actual time=0.071..0.071 rows=2000.00 loops=10)
                                Index Cond: (building_id = authorized."buildingId")
                                Index Searches: 10
                                Buffers: shared hit=221
                          ->  Bitmap Index Scan on material_requests_client_idx  (cost=0.00..63.23 rows=8002 width=0) (actual time=0.506..0.506 rows=19999.00 loops=10)
                                Index Cond: (client_id = authorized."clientId")
                                Index Searches: 10
                                Buffers: shared hit=180
                          ->  Bitmap Index Scan on material_requests_item_idx  (cost=0.00..122.59 rows=9906 width=0) (actual time=0.280..0.280 rows=10000.00 loops=10)
                                Index Cond: (item_id = '05705be6-bd90-4ca0-ac24-0ab6ba31c272'::uuid)
                                Index Searches: 10
                                Buffers: shared hit=100
                    SubPlan 2
                      ->  Seq Scan on inventory_warehouses w  (cost=0.00..2.60 rows=60 width=48) (actual time=0.007..0.013 rows=60.00 loops=1)
                            Buffers: shared hit=2
        ->  Index Scan using purchase_requests_pkey on purchase_requests pr  (cost=0.28..0.37 rows=1 width=48) (actual time=0.001..0.001 rows=1.00 loops=9998)
              Index Cond: (id = mr.purchase_request_id)
              Filter: ((mr.client_id = client_id) AND (mr.building_id = building_id))
              Rows Removed by Filter: 0
              Index Searches: 9998
              Buffers: shared hit=29994
Planning:
  Buffers: shared hit=57
Planning Time: 1.053 ms
Execution Time: 33.874 ms
```

### selective / 1 building

Parameters ($1 item, $2 JSON exact pairs, optional $3 filter):

```json
[
  "8a5797f8-c679-427a-8eb6-43a8058c340b",
  "[{\"clientId\":\"dfdba920-0edb-46b5-ad7f-3519e30a896c\",\"buildingId\":\"43626b8c-cad3-4190-84d6-40e2bb954a82\"}]"
]
```

```text
Sort  (cost=76.86..76.87 rows=1 width=223) (actual time=0.197..0.199 rows=6.00 loops=1)
  Sort Key: mr.created_at DESC, mr.id DESC
  Sort Method: quicksort  Memory: 25kB
  Buffers: shared hit=60
  ->  Nested Loop  (cost=53.85..76.85 rows=1 width=223) (actual time=0.114..0.193 rows=6.00 loops=1)
        Join Filter: (mr.purchase_request_id = pr.id)
        Rows Removed by Join Filter: 295
        Buffers: shared hit=60
        ->  Nested Loop  (cost=53.57..70.92 rows=1 width=271) (actual time=0.110..0.118 rows=6.00 loops=1)
              Buffers: shared hit=36
              ->  Nested Loop  (cost=1.78..12.04 rows=1 width=64) (actual time=0.014..0.015 rows=1.00 loops=1)
                    Join Filter: (authorized."clientId" = i.client_id)
                    Buffers: shared hit=3
                    ->  Index Only Scan using inventory_items_price_scope_unique on inventory_items i  (cost=0.28..8.29 rows=1 width=32) (actual time=0.004..0.004 rows=1.00 loops=1)
                          Index Cond: (id = '8a5797f8-c679-427a-8eb6-43a8058c340b'::uuid)
                          Heap Fetches: 1
                          Index Searches: 1
                          Buffers: shared hit=3
                    ->  HashAggregate  (cost=1.50..2.50 rows=100 width=32) (actual time=0.009..0.009 rows=1.00 loops=1)
                          Group Key: authorized."clientId", authorized."buildingId"
                          Batches: 1  Memory Usage: 32kB
                          ->  Function Scan on jsonb_to_recordset authorized  (cost=0.00..1.00 rows=100 width=32) (actual time=0.006..0.006 rows=1.00 loops=1)
              ->  Bitmap Heap Scan on material_requests mr  (cost=51.79..58.86 rows=1 width=223) (actual time=0.095..0.100 rows=6.00 loops=1)
                    Recheck Cond: ((item_id = '8a5797f8-c679-427a-8eb6-43a8058c340b'::uuid) AND (building_id = authorized."buildingId"))
                    Filter: ((client_id = authorized."clientId") AND ((warehouse_id IS NULL) OR (ANY ((warehouse_id = (hashed SubPlan 2).col1) AND (client_id = (hashed SubPlan 2).col2) AND (building_id = (hashed SubPlan 2).col3)))))
                    Heap Blocks: exact=6
                    Buffers: shared hit=33
                    ->  BitmapAnd  (cost=51.79..51.79 rows=1 width=0) (actual time=0.064..0.064 rows=0.00 loops=1)
                          Buffers: shared hit=25
                          ->  Bitmap Index Scan on material_requests_item_idx  (cost=0.00..4.67 rows=50 width=0) (actual time=0.004..0.004 rows=51.00 loops=1)
                                Index Cond: (item_id = '8a5797f8-c679-427a-8eb6-43a8058c340b'::uuid)
                                Index Searches: 1
                                Buffers: shared hit=2
                          ->  Bitmap Index Scan on material_requests_building_idx  (cost=0.00..46.87 rows=1740 width=0) (actual time=0.057..0.057 rows=2000.00 loops=1)
                                Index Cond: (building_id = authorized."buildingId")
                                Index Searches: 1
                                Buffers: shared hit=23
                    SubPlan 2
                      ->  Seq Scan on inventory_warehouses w  (cost=0.00..2.60 rows=60 width=48) (actual time=0.003..0.009 rows=60.00 loops=1)
                            Buffers: shared hit=2
        ->  Index Scan using purchase_requests_building_idx on purchase_requests pr  (cost=0.28..5.90 rows=3 width=48) (actual time=0.002..0.009 rows=50.17 loops=6)
              Index Cond: (building_id = authorized."buildingId")
              Filter: (authorized."clientId" = client_id)
              Index Searches: 6
              Buffers: shared hit=24
Planning:
  Buffers: shared hit=57
Planning Time: 0.894 ms
Execution Time: 0.266 ms
```

### hot + status / 1 building

Parameters ($1 item, $2 JSON exact pairs, optional $3 filter):

```json
[
  "05705be6-bd90-4ca0-ac24-0ab6ba31c272",
  "[{\"clientId\":\"dfdba920-0edb-46b5-ad7f-3519e30a896c\",\"buildingId\":\"43626b8c-cad3-4190-84d6-40e2bb954a82\"}]",
  "OPEN"
]
```

```text
Sort  (cost=1097.01..1097.01 rows=1 width=223) (actual time=5.425..5.468 rows=798.00 loops=1)
  Sort Key: mr.created_at DESC, mr.id DESC
  Sort Method: quicksort  Memory: 151kB
  Buffers: shared hit=3538
  ->  Nested Loop  (cost=967.71..1097.00 rows=1 width=223) (actual time=3.538..5.108 rows=798.00 loops=1)
        Join Filter: ((authorized."clientId" = pr.client_id) AND (authorized."buildingId" = pr.building_id))
        Buffers: shared hit=3538
        ->  Nested Loop  (cost=967.43..1075.02 rows=54 width=271) (actual time=3.530..3.953 rows=798.00 loops=1)
              Buffers: shared hit=1144
              ->  Nested Loop  (cost=1.78..12.04 rows=1 width=64) (actual time=0.015..0.017 rows=1.00 loops=1)
                    Join Filter: (authorized."clientId" = i.client_id)
                    Buffers: shared hit=3
                    ->  Index Only Scan using inventory_items_price_scope_unique on inventory_items i  (cost=0.28..8.29 rows=1 width=32) (actual time=0.005..0.006 rows=1.00 loops=1)
                          Index Cond: (id = '05705be6-bd90-4ca0-ac24-0ab6ba31c272'::uuid)
                          Heap Fetches: 1
                          Index Searches: 1
                          Buffers: shared hit=3
                    ->  HashAggregate  (cost=1.50..2.50 rows=100 width=32) (actual time=0.009..0.010 rows=1.00 loops=1)
                          Group Key: authorized."clientId", authorized."buildingId"
                          Batches: 1  Memory Usage: 32kB
                          ->  Function Scan on jsonb_to_recordset authorized  (cost=0.00..1.00 rows=100 width=32) (actual time=0.006..0.006 rows=1.00 loops=1)
              ->  Bitmap Heap Scan on material_requests mr  (cost=965.65..1062.85 rows=12 width=223) (actual time=3.514..3.767 rows=798.00 loops=1)
                    Recheck Cond: ((item_id = '05705be6-bd90-4ca0-ac24-0ab6ba31c272'::uuid) AND (status = 'OPEN'::text) AND (client_id = authorized."clientId") AND (building_id = authorized."buildingId"))
                    Filter: ((warehouse_id IS NULL) OR (ANY ((warehouse_id = (hashed SubPlan 2).col1) AND (client_id = (hashed SubPlan 2).col2) AND (building_id = (hashed SubPlan 2).col3))))
                    Rows Removed by Filter: 1
                    Heap Blocks: exact=45
                    Buffers: shared hit=1141
                    ->  BitmapAnd  (cost=965.65..965.65 rows=17 width=0) (actual time=3.474..3.474 rows=0.00 loops=1)
                          Buffers: shared hit=1094
                          ->  Bitmap Index Scan on material_requests_item_idx  (cost=0.00..119.76 rows=7947 width=0) (actual time=0.202..0.202 rows=8000.00 loops=1)
                                Index Cond: ((item_id = '05705be6-bd90-4ca0-ac24-0ab6ba31c272'::uuid) AND (status = 'OPEN'::text))
                                Index Searches: 1
                                Buffers: shared hit=8
                          ->  Bitmap Index Scan on material_requests_rfq_scope_unique  (cost=0.00..844.30 rows=174 width=0) (actual time=3.252..3.252 rows=1999.00 loops=1)
                                Index Cond: ((client_id = authorized."clientId") AND (building_id = authorized."buildingId"))
                                Index Searches: 1
                                Buffers: shared hit=1086
                    SubPlan 2
                      ->  Seq Scan on inventory_warehouses w  (cost=0.00..2.60 rows=60 width=48) (actual time=0.004..0.010 rows=60.00 loops=1)
                            Buffers: shared hit=2
        ->  Index Scan using purchase_requests_pkey on purchase_requests pr  (cost=0.28..0.39 rows=1 width=48) (actual time=0.001..0.001 rows=1.00 loops=798)
              Index Cond: (id = mr.purchase_request_id)
              Filter: ((mr.client_id = client_id) AND (mr.building_id = building_id))
              Index Searches: 798
              Buffers: shared hit=2394
Planning:
  Buffers: shared hit=57
Planning Time: 1.000 ms
Execution Time: 5.545 ms
```

### hot + PR / 1 building

Parameters ($1 item, $2 JSON exact pairs, optional $3 filter):

```json
[
  "05705be6-bd90-4ca0-ac24-0ab6ba31c272",
  "[{\"clientId\":\"dfdba920-0edb-46b5-ad7f-3519e30a896c\",\"buildingId\":\"43626b8c-cad3-4190-84d6-40e2bb954a82\"}]",
  "7282a187-decf-41cd-87e3-e7fce42a3153"
]
```

```text
Sort  (cost=72.22..72.22 rows=1 width=223) (actual time=0.188..0.190 rows=7.00 loops=1)
  Sort Key: mr.created_at DESC, mr.id DESC
  Sort Method: quicksort  Memory: 26kB
  Buffers: shared hit=53
  ->  Nested Loop  (cost=53.62..72.21 rows=1 width=223) (actual time=0.166..0.183 rows=7.00 loops=1)
        Buffers: shared hit=53
        ->  Nested Loop  (cost=53.34..70.94 rows=1 width=255) (actual time=0.161..0.169 rows=7.00 loops=1)
              Buffers: shared hit=32
              ->  Nested Loop  (cost=1.78..12.30 rows=1 width=80) (actual time=0.014..0.015 rows=1.00 loops=1)
                    Join Filter: ((authorized."clientId" = pr.client_id) AND (authorized."buildingId" = pr.building_id))
                    Buffers: shared hit=3
                    ->  Index Only Scan using purchase_requests_rfq_scope_unique on purchase_requests pr  (cost=0.28..8.30 rows=1 width=48) (actual time=0.004..0.004 rows=1.00 loops=1)
                          Index Cond: (id = '7282a187-decf-41cd-87e3-e7fce42a3153'::uuid)
                          Heap Fetches: 1
                          Index Searches: 1
                          Buffers: shared hit=3
                    ->  HashAggregate  (cost=1.50..2.50 rows=100 width=32) (actual time=0.008..0.009 rows=1.00 loops=1)
                          Group Key: authorized."clientId", authorized."buildingId"
                          Batches: 1  Memory Usage: 32kB
                          ->  Function Scan on jsonb_to_recordset authorized  (cost=0.00..1.00 rows=100 width=32) (actual time=0.005..0.005 rows=1.00 loops=1)
              ->  Bitmap Heap Scan on material_requests mr  (cost=51.56..58.63 rows=1 width=223) (actual time=0.146..0.151 rows=7.00 loops=1)
                    Recheck Cond: ((purchase_request_id = '7282a187-decf-41cd-87e3-e7fce42a3153'::uuid) AND (building_id = authorized."buildingId"))
                    Filter: ((item_id = '05705be6-bd90-4ca0-ac24-0ab6ba31c272'::uuid) AND (client_id = authorized."clientId") AND ((warehouse_id IS NULL) OR (ANY ((warehouse_id = (hashed SubPlan 2).col1) AND (client_id = (hashed SubPlan 2).col2) AND (building_id = (hashed SubPlan 2).col3)))))
                    Rows Removed by Filter: 12
                    Heap Blocks: exact=2
                    Buffers: shared hit=29
                    ->  BitmapAnd  (cost=51.56..51.56 rows=1 width=0) (actual time=0.097..0.097 rows=0.00 loops=1)
                          Buffers: shared hit=25
                          ->  Bitmap Index Scan on material_requests_purchase_request_idx  (cost=0.00..4.44 rows=20 width=0) (actual time=0.003..0.004 rows=19.00 loops=1)
                                Index Cond: (purchase_request_id = '7282a187-decf-41cd-87e3-e7fce42a3153'::uuid)
                                Index Searches: 1
                                Buffers: shared hit=2
                          ->  Bitmap Index Scan on material_requests_building_idx  (cost=0.00..46.87 rows=1740 width=0) (actual time=0.091..0.092 rows=2000.00 loops=1)
                                Index Cond: (building_id = authorized."buildingId")
                                Index Searches: 1
                                Buffers: shared hit=23
                    SubPlan 2
                      ->  Seq Scan on inventory_warehouses w  (cost=0.00..2.60 rows=60 width=48) (actual time=0.004..0.014 rows=60.00 loops=1)
                            Buffers: shared hit=2
        ->  Index Only Scan using inventory_items_price_scope_unique on inventory_items i  (cost=0.28..1.25 rows=1 width=32) (actual time=0.002..0.002 rows=1.00 loops=7)
              Index Cond: ((id = '05705be6-bd90-4ca0-ac24-0ab6ba31c272'::uuid) AND (client_id = authorized."clientId"))
              Heap Fetches: 7
              Index Searches: 7
              Buffers: shared hit=21
Planning:
  Buffers: shared hit=45
Planning Time: 0.785 ms
Execution Time: 0.232 ms
```
