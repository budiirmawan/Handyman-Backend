# W02 PART 02 — Operations Queue & Intake Handoff (Evidence)

Authority: Handyman Journey v1.3 FROZEN, dan `docs/e2e/W02_ASSISTED_INTAKE_GAP_RECONCILIATION.md`.
Baseline: `d23b9ce`. Branch: `arena/c6fc25e1-handyman-backend`.

Cakupan: Operations Queue read projection untuk request hasil Customer Care Assisted Intake. Tidak ada Work Order engine baru, tidak ada reporter, PIC selection, approval quotation, cancellation, atau notification engine.

## 1. Endpoint

| Method | Path | Permission | Scope |
|---|---|---|---|
| GET | `/api/v1/handyman/operations/requests` | `tenant_company.read` | Explicit ACTIVE Building assignment |
| GET | `/api/v1/handyman/operations/requests/:handymanRequestId` | `tenant_company.read` | Sama dengan list |

Query list: `status` (status Handyman yang dikenal), `buildingId` (UUID, di luar scope menghasilkan halaman kosong), `limit` (1–100, default 20), `cursor` (opaque). Parameter lain, termasuk `clientId` dan `tenantCompanyId`, ditolak 400.

Respons list: `data: { items, nextCursor }`. Urutan FIFO (`createdAt` ASC, `id` ASC). Respons detail: `data` berisi item yang sama.

Projection item: `id`, `clientId`, `status`, `description`, `createdAt`, `updatedAt`, `tenant {id, code, name, picId}`, `location {propertyId, propertyName, buildingId, buildingCode, buildingName, spaceId, spaceCode, spaceName}`, `service {catalogId, catalogName, variantId}`, `attribution {originChannel, actorType, careActorId, createdAt}`.

Dikecualikan dari projection: `actorReference`, `createdByUserId`, token/exchange/assertion, data kontak PIC.

## 2. Keputusan yang diterapkan

| ID | Keputusan | Alasan |
|---|---|---|
| OQ-1 | Scope = explicit ACTIVE Building assignment, dengan chain Building, Property, Client, dan User ACTIVE | Sesuai D6 (gap reconciliation). Tidak ada shortcut PIC, tidak ada bypass PLATFORM_ADMIN. |
| OQ-2 | `customerRequestReadScope` dan `GET /handyman/requests` tidak diubah | Dinding C6 tetap. Test membuktikan dinding tetap berlaku. |
| OQ-3 | **Fail-closed untuk identitas tenant**: user dengan PIC ACTIVE tidak pernah mendapat queue, meskipun punya Building assignment | C6 mensyaratkan PIC punya assignment (`canAccessClient`). Tanpa guard ini, PIC tenant akan melihat request tenant lain di building yang sama. |
| OQ-4 | Operator building melihat semua tenant di building yang di-assign | Ini otoritas building yang eksplisit. Perlu persetujuan, lihat residual R-2. |
| OQ-5 | Unknown dan out-of-scope mendapat 404 yang sama | Tidak ada oracle keberadaan lintas building atau client. |
| OQ-6 | Cursor opaque `{c, i}` tervalidasi ketat | Cursor tidak bisa memperluas scope karena scope selalu ada di SQL. |

## 3. Implementasi

- `src/modules/handyman-requests/handyman-operations-queue.repository.ts`: SQL projection dan scope.
- `src/modules/handyman-requests/handyman-operations-queue.service.ts`: mapper publik, pagination, detail.
- `src/modules/handyman-api/handyman-api.validation.ts`: `parseHandymanOperationsRequestListQuery` (allowlist, status, limit, cursor).
- `src/modules/handyman-api/handyman-api.controller.ts` dan `handyman-api.routes.ts`: dua handler dan dua route.
- `docs/api/openapi.yaml`: dua path baru dan schema `HandymanOperationsRequest`. Spec tetap OpenAPI 3.0.3 (`nullable: true`).

## 4. Bukti runtime

Test: `tests/handyman-operations-queue.test.ts` (embedded PostgreSQL, fixture lewat jalur Customer Care nyata: admission, create-exchange, `POST /handyman/requests/care`).

| # | Test | Hasil |
|---|---|---|
| 1 | Operator terotorisasi membaca queue Building-nya; Building, Property, dan Client lain tidak muncul | PASS |
| 2 | Cross-property dan cross-client tidak bocor secara lateral | PASS |
| 3 | Projection tidak memuat `actorReference`, `createdByUserId`, token, assertion, atau kontak PIC | PASS |
| 4 | Request dari `POST /handyman/requests/care` muncul di queue pada read berikutnya | PASS |
| 5 | Pagination FIFO tanpa duplikat dan tanpa baris di luar scope | PASS |
| 6 | Filter status dan buildingId tidak memperluas scope | PASS |
| 7 | Query tidak valid ditolak; cursor yang dibuat untuk row luar scope tidak membocorkan row | PASS |
| 8 | Detail in-scope 200; out-of-scope dan unknown 404 dengan bentuk error identik | PASS |
| 9 | User tanpa assignment: queue kosong, detail 404 | PASS |
| 10 | User dengan assignment tetapi tanpa `tenant_company.read`: 403 | PASS |
| 11 | Tenant PIC dengan assignment tidak membuka queue (fail-closed) | PASS |
| 12 | `GET /handyman/requests` tetap pada C6: operator tanpa PIC tidak melihat, PIC melihat tenant-nya sendiri | PASS |
| 13 | Permission dicabut: 403 pada request berikutnya | PASS |
| 14 | Session dicabut: 401 | PASS |
| 15 | Assignment Building dinonaktifkan: request hilang dari queue | PASS |

Hasil file test: **15 PASS, 0 FAIL, 0 SKIP**.

Mutation check: guard PIC (OQ-3) dinonaktifkan sementara, lalu test 11 GAGAL. Guard dikembalikan. Ini membuktikan test 11 benar-benar menguji guard.

### Regresi focused (5 file)

| File | Hasil |
|---|---|
| `handyman-operations-queue.test.ts` | 15 PASS |
| `handyman-customer-care-request-reads.test.ts` | PASS (C6 tidak berubah) |
| `handyman-care-workspace-create-exchange.test.ts` | PASS |
| `handyman-lifecycle-api.test.ts` | PASS (triage) |
| `handyman-api.test.ts` | 11 PASS |
| **Total** | **64 PASS, 0 FAIL, 0 SKIP** |

Typecheck: `npx tsc --noEmit` exit 0.

### Perubahan ekspektasi test yang sudah ada

`tests/handyman-api.test.ts` (test 10, "OpenAPI matches the actual CR-HM-02 HTTP surface exactly") sebelumnya GAGAL karena route `DELETE /handyman/care-actors/{careActorId}/permissions/{permissionCode}` dari PART 06 belum ada di daftar pengecualian. Route ini ada di HEAD (`handyman-care-actor-permission.routes.ts`, `router.delete`). Pengecualian ditambahkan hanya untuk path dan verb yang sama. Verb lain tetap dilarang. Kegagalan ini sudah ada sebelum PART 02 dan bukan akibat perubahan PART 02.

## 5. Residual gap (untuk PART berikutnya)

| ID | Gap | Severity | Rencana |
|---|---|---|---|
| R-1 | Triage dari queue belum diuji end-to-end (queue lalu `POST /handyman/requests/:id/triage`). Triage memakai guard yang sama, tetapi belum dibuktikan dalam satu alur. | P1 | Test alur queue lalu triage di PART 03 |
| R-2 | OQ-4: operator building melihat semua tenant di building-nya. Perlu persetujuan bisnis. | P0 (keputusan) | Keputusan D6 lanjutan |
| R-3 | Role produksi mana yang memegang `tenant_company.read` belum diverifikasi dari seed. Seed hanya mendefinisikan permission. | P1 | Verifikasi RBAC provisioning |
| R-4 | Reporter dan kontak pelapor (G05, G06) belum ada | P0 | W02 PART 10 (sesuai gap reconciliation) |
| R-5 | Notifikasi `HANDYMAN_REQUEST_CREATED` dan audit create (G22, G23) belum ada | P1 | W02 PART 12 |
| R-6 | Approval quotation oleh PIC (G08) belum ada | P0 | W02 PART 11 |
| R-7 | Frontend Operations queue UNVERIFIED (tidak ada di repo ini) | UNVERIFIED | Verifikasi di repo frontend |
| R-8 | Tidak ada E2E lintas repo. Bukti hanya backend runtime. | — | Tidak diklaim |
| R-9 | Queue menampilkan semua status, tidak hanya INTAKE. Pemfilteran per status tersedia lewat query. | P2 | Konfirmasi produk |
