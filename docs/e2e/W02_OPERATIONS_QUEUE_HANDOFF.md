# W02 PART 02 / 02A — Operations Queue & Intake Handoff (Evidence)

Authority: Handyman Journey v1.3 FROZEN, dan `docs/e2e/W02_ASSISTED_INTAKE_GAP_RECONCILIATION.md`.
Baseline PART 02: `954a013`. PART 02A (operations authority hardening) menyusul di commit berikutnya pada branch `arena/c6fc25e1-handyman-backend`.

Cakupan: Operations Queue read projection untuk request hasil Customer Care Assisted Intake. Tidak ada Work Order engine, PIC selection, (reporter/contact snapshot read-only sejak PART 03), approval quotation, cancellation, notification engine, atau frontend.

## 1. Endpoint

| Method | Path | Permission | Scope tambahan |
|---|---|---|---|
| GET | `/api/v1/handyman/operations/requests` | `handyman.operations.request.read` | ACTIVE Building assignment |
| GET | `/api/v1/handyman/operations/requests/:handymanRequestId` | `handyman.operations.request.read` | ACTIVE Building assignment (sama dengan list) |

Query list: `status`, `buildingId` (di luar scope menghasilkan halaman kosong), `limit` (1–100, default 20), `cursor` (opaque). Parameter lain, termasuk `clientId` dan `tenantCompanyId`, ditolak 400.

Respons list tetap: `data: { items, nextCursor }` (backward compatible dengan PART 02). Urutan FIFO. Respons detail memakai item yang sama.

Projection item: `id`, `clientId`, `status`, `description`, `createdAt`, `updatedAt`, `tenant {id, code, name, picId}`, `location {propertyId, propertyName, buildingId, buildingCode, buildingName, spaceId, spaceCode, spaceName}`, `service {catalogId, catalogName, variantId}`, `attribution {originChannel, actorType, careActorId, createdAt}`.

Dikecualikan: `actorReference`, `createdByUserId`, token/exchange/assertion, data kontak PIC.

## 2. Permission registry dan provisioning

| Item | Nilai |
|---|---|
| Code | `handyman.operations.request.read` |
| Registry | Migration `0434_handyman_operations_request_permission` (katalog `permissions`, ON CONFLICT DO NOTHING) dan `FOUNDATION_PERMISSIONS` di seed |
| Default grant | **Tidak ada**. Code ada di `UNASSIGNED_BY_DEFAULT_PERMISSION_CODES`, sehingga PLATFORM_ADMIN dan role lain tidak mewarisinya |
| Pengganti | `tenant_company.read` tidak lagi menjadi authority queue |

Provisioning produksi (keputusan, belum dilakukan):
- Repository hanya mendefinisikan satu role, `PLATFORM_ADMIN`. Role aplikasi (Operations, Dispatcher, Supervisor, dan lainnya) diprovisikan lewat kebijakan atau konfigurasi, sesuai komentar di seed.
- Karena role Operations produksi tidak terdefinisi di repository, tidak ada grant yang diberikan dari kode. Itu sengaja.
- Rekomendasi: role Operations yang disetujui diberi `handyman.operations.request.read` secara eksplisit, dengan pencatatan siapa yang memberi. Pemegang `tenant_company.read` yang sekarang tidak otomatis mendapat akses.
- Dampak: operator yang belum diprovisikan menerima 403 pada queue. Endpoint queue belum dipakai produksi (PART 02 hanya menambah endpoint), jadi tidak ada regresi produksi yang diketahui.

## 3. Keputusan authority (PART 02A)

| ID | Keputusan | Alasan |
|---|---|---|
| OQ-1 | Authority = permission `handyman.operations.request.read` (route guard) **dan** ACTIVE Building assignment, dengan chain Building, Property, Client, dan User ACTIVE | Permission membuktikan fungsi. Assignment membuktikan cakupan building. Tidak ada role-name check. |
| OQ-2 | Blanket exclusion PIC ACTIVE **dihapus** dan diganti authority berbasis permission | User dengan PIC dan permission Operations boleh (dual-role). PIC tanpa permission ditolak 403. |
| OQ-3 | User dengan permission tetapi tanpa ACTIVE Building assignment: **403 `BUILDING_ACCESS_DENIED`** untuk list dan detail | Penolakan eksplisit. Memakai resolver building yang sudah ada (`getAccessibleBuildingIds`). |
| OQ-4 | User inactive atau session dicabut: **401** dari authentication | Perilaku existing. Scope SQL juga memfilter `users.status = 'ACTIVE'`. |
| OQ-5 | Unknown, di building lain, atau di client lain: **404** dengan bentuk error yang sama | Tidak ada oracle keberadaan. |
| OQ-6 | Operator building melihat semua tenant di building yang di-assign | Mengikuti scope building eksplisit. Perlu persetujuan, lihat R-2. |
| OQ-7 | `customerRequestReadScope`, `GET /handyman/requests`, dan route generic tidak diubah | Dinding C6 tetap. Bukti: 0 baris diff pada repository, service, dan controller generic. |

## 4. Perubahan ekspektasi test (diverifikasi terhadap route aktual)

| Test sebelumnya | Ekspektasi lama | Ekspektasi baru | Alasan |
|---|---|---|---|
| User tanpa assignment | 200 queue kosong, detail 404 | 403 `BUILDING_ACCESS_DENIED` | OQ-3, penolakan eksplisit |
| PIC dengan assignment (tanpa OPS) | 200 queue kosong | 403 | OQ-2 |
| Assignment dinonaktifkan (satu-satunya) | 200 kosong | 403 untuk assignment terakhir. Dengan dua assignment, B1 hilang dan B2 tetap | OQ-3 |
| `config-perm-01` test A | katalog 352 | katalog 353 | Satu code baru dari PART 02A |
| `config-perm-01` test L | daftar unassigned tanpa code baru | `handyman.operations.request.read` ditambahkan | Policy default sengaja tidak memberi grant |
| `handyman-api` test 10 (PART 02) | daftar DELETE hanya `/handyman/care/session` | ditambah path `/handyman/care-actors/{careActorId}/permissions/{permissionCode}` | Route DELETE PART 06 yang sudah ada |

## 5. Bukti runtime

### 5.1 `tests/handyman-operations-queue.test.ts`: 19 PASS, 0 FAIL, 0 SKIP

Fixture memakai jalur Customer Care nyata (admission, create-exchange, `POST /handyman/requests/care`), dengan embedded PostgreSQL.

| # | Test | Hasil |
|---|---|---|
| 1 | Authorized Operations membaca queue Building-nya; Building, Property, dan Client lain tidak muncul | PASS |
| 2 | Cross-property dan cross-client: operator P2 dan client B hanya melihat Building-nya | PASS |
| 3 | Projection tidak memuat `actorReference`, `createdByUserId`, token, assertion, atau email kontak | PASS |
| 4 | Request dari `POST /handyman/requests/care` muncul untuk Operations yang berwenang | PASS |
| 5 | Pagination FIFO sama dengan urutan tanpa paging; tanpa duplikat | PASS |
| 6 | Filter status dan buildingId tidak memperluas scope | PASS |
| 7 | Query tidak valid ditolak; cursor ke row luar scope tidak membocorkan row | PASS |
| 8 | Detail in-scope 200; out-of-scope dan unknown 404 dengan error identik | PASS |
| 9 | Permission tanpa Building assignment: 403 pada list dan detail | PASS |
| 10 | `tenant_company.read` saja tidak lagi authority queue: 403 | PASS |
| 11 | Permission lain (`checklist.read`) dengan assignment: 403 | PASS |
| 12 | Tenant PIC tanpa permission Operations (dengan assignment): 403 | PASS |
| 13 | Dual-role (PIC + permission + assignment): 200, Building-scoped, tetap fail-closed di luar Building | PASS |
| 14 | `GET /handyman/requests` tetap C6: non-PIC tidak melihat, PIC melihat tenant-nya, permission Operations tidak membuka generic | PASS |
| 15 | Permission dicabut: 403 | PASS |
| 16 | Session dicabut: 401 | PASS |
| 17 | Assignment dinonaktifkan: hanya Building yang dicabut hilang; assignment terakhir dicabut menjadi 403 | PASS |
| 18 | User inactive: 401 | PASS |
| 19 | Parity list dan detail: setiap item identik dengan detailnya | PASS |

Mutation check (PART 02A): route guard `handyman.operations.request.read` dinonaktifkan sementara. Empat test gagal (10, 11, 12, 15). Guard dikembalikan.

Mutation check (PART 02): guard PIC dinonaktifkan sementara. Test PART 02 "fail-closed PIC" gagal, lalu dikembalikan.

### 5.2 Regresi focused

| File | Hasil |
|---|---|
| `handyman-operations-queue.test.ts` | 19 PASS |
| `handyman-customer-care-request-reads.test.ts` | PASS (C6 tidak berubah) |
| `handyman-care-workspace-create-exchange.test.ts` | PASS |
| `handyman-lifecycle-api.test.ts` | PASS (triage) |
| `handyman-api.test.ts` | PASS |
| `config-perm-01-permission-registry.test.ts` | 13 PASS (setelah PART 02B, lihat 5.3) |
| **Total** | **80 PASS, 1 FAIL, 0 SKIP** |

Typecheck: `npx tsc --noEmit` exit 0.

### 5.3 Kegagalan yang sudah ada (RESOLVED di PART 02B)

`config-perm-01` test 13 (ROUTE-TO-REGISTRY) sebelumnya gagal karena `handyman.payment.report` dan `handyman.payment.verify` tidak ada di `FOUNDATION_PERMISSIONS`. PART 02B mendaftarkannya tanpa default grant. Detail dan bukti: `W02_VERIFICATION_DEBT.md` §1. Hasil: 13/13 PASS.

### 5.4 Bukti C6 tidak berubah

- `src/modules/handyman-requests/handyman-service-request.repository.ts`: 0 baris diff (berisi `customerRequestReadScope`).
- `src/modules/handyman-requests/handyman-service-request.service.ts`: 0 baris diff.
- `src/modules/handyman-api/handyman-api.controller.ts` (handler generic): 0 baris diff.
- `src/modules/handyman-api/handyman-api.routes.ts`: hanya dua route Operations yang berubah (`read` menjadi `operationsRead`). Route generic tidak berubah.

## 6. Residual gap

| ID | Gap | Severity | Rencana |
|---|---|---|---|
| R-1 | Alur queue lalu triage belum diuji sebagai satu alur | P1 | PART 03 |
| R-2 | OQ-6: operator building melihat semua tenant di building yang di-assign | P0 (keputusan) | Persetujuan bisnis |
| R-3 | Provisioning role Operations produksi belum diputuskan. Tidak ada grant dari kode. | P0 (keputusan provisioning) | Lihat §2 |
| R-4 | Reporter dan kontak pelapor (G05, G06) | PARTIAL: snapshot intake dan read Operations ada sejak PART 03 (`W02_VERIFICATION_DEBT.md` §5). Reporter belum wajib, dan identitasnya belum diverifikasi | W02 PART 10 untuk sisa |
| R-5 | Notifikasi `HANDYMAN_REQUEST_CREATED` dan audit create (G22, G23) belum ada | P1 | W02 PART 12 |
| R-6 | Approval quotation oleh PIC (G08) belum ada | P0 | W02 PART 11 |
| R-7 | Frontend Operations queue UNVERIFIED (tidak ada di repo ini) | UNVERIFIED | Repo frontend |
| R-8 | Tidak ada E2E lintas repo. Bukti hanya backend runtime. | — | Tidak diklaim |
| R-9 | Payment permission codes (ROUTE-TO-REGISTRY) | RESOLVED (PART 02B) | `W02_VERIFICATION_DEBT.md` §1 |
| R-10 | Test `r08-*` menyebut 348 migration. Repo sekarang punya 434. Tidak dijalankan di PART ini | P2 | Perbaikan terpisah |

## PART 04 update — triage

- Journey intake → queue → triage → queue ulang tervalidasi (`tests/handyman-intake-triage-journey.test.ts`).
- Triage memakai authority existing `tenant_company.manage` + Building scope. Queue permission saja tidak memberi triage atau membaca hasil triage. Keputusan authority ada di `W02_VERIFICATION_DEBT.md` §6 (R-T1).
