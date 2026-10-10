# W02 Verification Debt & Permission Registry Reconciliation

Dokumen ini adalah register tunggal untuk debt verifikasi W02 dan hasil reconciliation permission registry (PART 02B).
Baseline: `9522f99`. Branch: `arena/c6fc25e1-handyman-backend`.

## 1. Reconciliation: ROUTE-TO-REGISTRY (`config-perm-01` test 13)

### Akar masalah (terbukti)

- Test `config-perm-01` memeriksa bahwa setiap `requirePermission(...)` yang di-mount ada di `FOUNDATION_PERMISSIONS`.
- `handyman.payment.report` dan `handyman.payment.verify` dipakai oleh route ledger/payment (`handyman-customer-ledger-api.routes.ts`).
- Kedua kode didaftarkan hanya di migration `0432_handyman_care_actor_payment_permission`. Tidak ada di seed `FOUNDATION_PERMISSIONS`.
- Akibatnya test gagal sejak PART 05/06. Sudah dibuktikan dengan menjalankan test pada HEAD `954a013` (stash sementara), hasilnya sama.

### Keputusan registry (PART 02B)

| Kode | Nama (sama dengan migration 0432) | Terdaftar di seed | Default grant | Batasan |
|---|---|---|---|---|
| `handyman.payment.report` | Report Handyman Customer Payments | Ya | Tidak ada (UNASSIGNED) | Satu-satunya kode yang boleh ada pada grant Care Actor (CHECK 0432) |
| `handyman.payment.verify` | Verify Handyman Customer Payments | Ya | Tidak ada (UNASSIGNED) | User RBAC saja. Tidak boleh pada Care Actor. Maker-checker tetap berlaku |

Perubahan:
- `src/database/seeds/foundation-access.seed.ts`: dua kode ditambahkan ke `FOUNDATION_PERMISSIONS` dan `UNASSIGNED_BY_DEFAULT_PERMISSION_CODES`.
- `tests/config-perm-01-permission-registry.test.ts`: jumlah katalog 353 menjadi 355, dan dua kode masuk daftar unassigned yang diharapkan.

Tidak berubah: migration 0432 (tidak diedit), route, controller, payment workflow, C6, dan semua grant yang ada.

### Bukti tidak ada auto-grant

Test `tests/handyman-payment-permission-registry.test.ts` (5 test, PASS) pada DB yang baru di-migrate:
1. Kedua kode terdaftar tepat sekali, ACTIVE, dengan nama migration 0432.
2. Sebelum seed: tidak ada grant role untuk kedua kode.
3. Setelah seed foundation yang sebenarnya dijalankan (`foundationAccessSeed.run`): tetap tidak ada grant role. Sebagai sanity check, seed memang berjalan, karena PLATFORM_ADMIN memegang `tenant_company.read`.
4. User dengan role PLATFORM_ADMIN: `resolvePermissionsForUser` tidak mengembalikan kedua kode, sementara `tenant_company.read` tetap resolve.
5. CHECK allowlist Care Actor (`handyman_care_actor_perm_grants_code_check`) menolak `handyman.payment.verify` dengan SQLSTATE 23514.

## 2. Hasil test

### Focused (PART 02B)

| File | Hasil |
|---|---|
| `config-perm-01-permission-registry.test.ts` | 13 PASS (termasuk ROUTE-TO-REGISTRY yang sebelumnya gagal) |
| `handyman-payment-permission-registry.test.ts` | 5 PASS |
| `handyman-payment-verification-authority.test.ts` | PASS |
| `handyman-care-workspace-payment-report.test.ts` | PASS |
| `handyman-care-admin-provisioning.test.ts` | PASS |
| `handyman-customer-care-ledger.test.ts` | PASS |
| `handyman-customer-care-transport-certification.test.ts` | PASS, 2 SKIP (lihat §3, D-2) |
| **Total** | **61 PASS, 0 FAIL, 2 SKIP** (63 test) |

Typecheck: `npx tsc --noEmit` exit 0.

### Mutation check

Tidak dijalankan untuk PART 02B. Tidak ada perubahan runtime authorization. Bukti tidak ada auto-grant berasal dari test runtime di §1.

## 3. Verification debt register

| ID | Debt | Status | Bukti / alasan | Rencana |
|---|---|---|---|---|
| D-1 | ROUTE-TO-REGISTRY (payment codes tidak terdaftar di seed) | **RESOLVED (PART 02B)** | §1, `config-perm-01` 13/13 PASS | — |
| D-2 | Dua assertion historis di `handyman-customer-care-transport-certification` (commit `b87d72f` dan `2fcfad9`) | SKIP eksplisit (sudah ada) | Commit tidak ada di repo atau remote. Skip diberi alasan eksplisit. Pemeriksaan struktural tetap berjalan | Hanya bisa diverifikasi jika baseline historis tersedia |
| D-3 | Test `r08-part01b-operational-detail-evidence` dan `r08-part02b-operational-detail-finding` mengasumsikan 348 migration. Repo sekarang 434 file migration (`0001`–`0434`) | Belum diverifikasi, ini bukan regresi PART 02B | Tidak dijalankan di PART ini | Perbaikan terpisah, di luar W02 |
| D-4 | Seed dijalankan pada DB non-embedded dalam test runtime (`handyman-payment-permission-registry`) | Risiko kecil | Di mode embedded, DB direset. Di mode non-embedded, seed menambah grant ke PLATFORM_ADMIN di DB bersama | Gunakan embedded untuk CI atau isolasi DB |
| D-5 | Payment registry tidak punya route guard test baru | Di luar cakupan | Route guard dicakup oleh test payment authorization yang sudah ada | — |
| D-6 | Frontend Customer Care dan Operations | UNVERIFIED | Tidak ada di repo ini | Repo frontend |
| D-7 | E2E lintas repo | Tidak diklaim | Tidak ada bukti | — |
| D-8 | Provisioning role Operations produksi (`handyman.operations.request.read`) | Keputusan terbuka | Tidak ada grant dari kode | Lihat `W02_OPERATIONS_QUEUE_HANDOFF.md` §2 |
| D-9 | Reporter, PIC approval, notifikasi, dan audit create W02 | Belum diimplementasi | Lihat gap reconciliation | PART 10 sampai PART 12 |

## 4. Residual

- Tidak ada kegagalan P0 yang bersifat registry atau authorization dari PART 02B.
- Keputusan terbuka tetap: R-2 (operator building melihat semua tenant di building) dan provisioning role Operations (D-8).
- PLATFORM_ADMIN tidak menerima `handyman.payment.report` maupun `handyman.payment.verify` secara default. Jika bisnis ingin memberikannya, itu harus lewat keputusan provisioning terpisah dan tercatat.
