# W03 PART 03H-02 — Verification Foundation Reconciliation

| Field | Value |
|---|---|
| Status | **E2E NOT CERTIFIED.** Rekonsiliasi **parsial**: 10 dari 38 fixture legacy dikonversi. Sisanya dicatat di register PART lanjutan (§7). |
| Baseline | `ff6e3a2` (HEAD = `origin/arena/c3a50946-handyman-backend`, ancestor, ahead/behind 0/0, tree bersih saat mulai) |
| Bahasa | Indonesia |
| Acuan | `W03_PART03H-01_E2E_CERTIFICATION_PREFLIGHT.md`, CR-HM-06 Amendment 01, ADD-A, Decision Freeze F6 |

## 1. Ringkasan

- **Tidak ada perubahan di `src/`, migrasi, ledger, Execution Scope, atau B12.** `git diff -- src` kosong. Perubahan hanya di `tests/` (11 file).
- **Dua kelemahan test PIC session diperbaiki** dan terbukti lulus di DB bersih maupun DB bersama (25/25).
- **`handyman-arrival-challenges` 10/10 PASS** dengan approval PIC nyata (sebelumnya 0/10, `PERMISSION_DENIED`).
- **Sembilan file (termasuk `arrival-challenges`) dikonversi dan PASS** ke jalur PIC nyata (admission PIC, binding eksplisit, decision PIC). Satu lagi (`chargeable-additional-work-scope-guard`) terkonversi dengan benar, tetapi masih merah di lapisan authority berikutnya.
- **Tes negatif S1 tetap utuh dan hijau:** staff APPROVE/REJECT → 403 (`quotation-decision` 10/10, `pic-portal-decide` 30/30, `pic-portal-read` 25/25, `quotation-pic-binding-migration` 14/14).
- **Koreksi klasifikasi:** `handyman-scope-assignments-api` 9/10 gagal ternyata S1, bukan debt lama. Dikoreksi di 03H-01 G20.
- **Status E2E tidak berubah:** NOT CERTIFIED. Tidak ada P0 gate yang ditutup oleh turn ini.

## 2. Verifikasi baseline

| Pemeriksaan | Hasil |
|---|---|
| Branch | `arena/c3a50946-handyman-backend` |
| HEAD = remote | `ff6e3a2` = `ff6e3a2` |
| Ancestor | ya |
| Ahead/behind | 0/0 |
| Tree saat mulai | bersih |

## 3. Perbaikan test PIC session (`tests/handyman-pic-workspace-session.test.ts`)

### 3.1 Asersi jumlah integration di-scope ke fixture

- **Akar masalah:** asersi `count(*) WHERE actor_capability='TENANT_PIC'` menghitung seluruh tabel. Fixture PIC di file lain (decide, binding) membuat integrasi TENANT_PIC di DB yang sama, sehingga hasil 2 ≠ 1.
- **Perbaikan:** asersi sekarang `WHERE actor_capability='TENANT_PIC' AND integration_code = $1` dengan `integrationCode` milik fixture ini.
- **Bukti:** DB yang sudah berisi integrasi dari file lain (`h03h2_a`): 25/25. DB bersih (`h03h2_b`): 25/25.

### 3.2 Ketergantungan jendela waktu ~1 detik dihilangkan

- **Akar masalah:** kasus "tepat di batas 300 detik" membuat `issuedAt = floor(now − 299s)` dan `expiresAt = issuedAt + 300s`. Sisa masa berlaku hanya ~1 detik. Setelah enam admission lain, sesi sudah kedaluwarsa lalu server menjawab 401, sehingga asersi `201` gagal (baris 656). Gagal 2/2 pada DB bersih.
- **Perbaikan:** `base = floor(now) − 2s`. Jendela tetap **tepat 300 detik** (uji batas inklusif `<= 300s` tetap ada), tetapi sisa masa berlaku ~298 detik. Kasus 301 detik tetap ditolak, dan kasus expiry lainnya tidak diubah.
- **Yang tidak dilemahkan:** kasus `expired`, `future-issued`, `window over 300s`, `inverted window`, `equal instants`, dan `expires exactly now` tetap ada dan tidak diubah.
- **Bukti:** 25/25 di DB bersih dan DB bersama.

## 4. Rekonsiliasi fixture legacy

### 4.1 Pola perubahan (sama untuk semua file)

Sebelum (S1 → 403):
```ts
const decision = await decideHandymanQuotation(version.id, {
  decision: 'APPROVE', idempotencyKey: `k-${randomUUID()}`,
}, adminUserId);
```

Sesudah (jalur PIC nyata):
```ts
const picSession = await bindAndAdmitFixturePic({
  quotationId: bundle.quotation.id,
  tenantCompanyId: company.id, tenantPicId: pic.id,
  buildingId: realm.<building-scope>.id, spaceId: space.id,
  granterUserId: adminUserId,
});
const decision = await decideFixturePic(picSession.workspaceToken, version.id, {
  decision: 'APPROVE', idempotencyKey: `k-${randomUUID()}`,
}, adminUserId);
```

- `bindAndAdmitFixturePic` dan `decideFixturePic` berasal dari `tests/helpers/handyman-pic-fixtures.ts` (sudah dipakai fixture 03F). Binding dibuat lewat service dengan granter eksplisit. Tidak ada auto-binding, tidak ada fallback staff, dan tidak ada permission baru.
- Impor `decideHandymanQuotation` dihapus dari file yang dikonversi. Tidak ada referensi tersisa (diverifikasi oleh skrip dengan assert).
- `<building-scope>` mengikuti building scope file masing-masing (`buildingA1` pada file `bast-*`, `chargeable-*`, `customer-payment-*`, dan `work-session-*`; `building` pada `arrival-challenges`). Ini diverifikasi per file, bukan diasumsikan.

### 4.2 Batch konversi dan hasil

| # | File | Hasil sebelum | Hasil sesudah | Catatan |
|---|---|---|---|---|
| 1 | `handyman-arrival-challenges.test.ts` | 0/10 (PD) | **10/10 PASS** | Titik awal yang diminta. |
| 2 | `handyman-bast-reads-scope-guard.test.ts` | 0/2 (PD) | **2/2 PASS** | Building `buildingA1`. |
| 3 | `handyman-bast-signoff-scope-guard.test.ts` | 0/2 (PD) | **2/2 PASS** | |
| 4 | `handyman-bast-writes-scope-guard.test.ts` | 0/2 (PD) | **2/2 PASS** | |
| 5 | `handyman-customer-payment-scope-guard.test.ts` | 0/2 (PD) | **2/2 PASS** | |
| 6 | `handyman-work-session-reads-scope-guard.test.ts` | 0/2 (PD) | **2/2 PASS** | |
| 7 | `handyman-work-session-close-scope-guard.test.ts` | 0/2 (PD) | **2/2 PASS** | |
| 8 | `handyman-work-session-checkin-start-scope-guard.test.ts` | 0/2 (PD) | **2/2 PASS** | |
| 9 | `handyman-work-session-workclock-scope-guard.test.ts` | 0/2 (PD) | **2/2 PASS** | |
| 10 | `handyman-chargeable-additional-work-scope-guard.test.ts` | 0/2 (PD) | **0/2 FAIL (lapisan berikutnya)** | Decide PIC sekarang lulus. Propose gagal: `HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_NOT_AUTHORIZED`. Lihat §4.3. |

Setiap file dijalankan di **DB baru tersendiri** (`CREATE DATABASE` + migrasi 443 migration), sehingga tidak ada kontaminasi antar-file.

### 4.3 Kegagalan lapisan berikutnya: `chargeable-additional-work-scope-guard`

- Test memanggil `proposeHandymanChargeableAdditionalWork(staff, …)`. Service `assertChargeableLeadAction` (`handyman-chargeable-additional-work.service.ts:216`) hanya mengizinkan aktor yang menjadi **assignment lead** scope (`resolveHandymanAssignmentLead`).
- Fixture test tidak menetapkan staff tersebut sebagai lead. Ini adalah aturan otoritas di service, bukan S1.
- **Tidak diperbaiki** pada turn ini. Memperbaikinya berarti mengubah cara fixture meng-assign lead atau mengubah otoritas propose, dan keputusan itu di luar batas turn ini. Dicatat sebagai PART lanjutan (§7, G-N1).
- Konversi PIC pada file ini tetap benar dan dipertahankan, karena blok decide sudah lulus dan kegagalannya sekarang jelas.

## 5. Inventaris 38 fixture legacy (runtime, sebelum konversi batch 2–3)

Inventaris dijalankan di DB baru per file. Hasil di bawah ini adalah keadaan sebelum konversi, kecuali baris bertanda ✔.

| Kelompok | File | Pass/Fail (awal) | Penyebab | Status sekarang |
|---|---|---|---|---|
| Negatif S1 (lulus) | `pic-portal-read` | 25/0 | assert.rejects staff 403 | **PASS, dipertahankan** |
| Negatif S1 (lulus) | `quotation-decision` | 10/0 | staff APPROVE/REJECT → 403 | **PASS, dipertahankan** |
| Negatif S1 (lulus) | `quotation-pic-binding-migration` | 14/0 | ledger + staff refusal | **PASS, dipertahankan** |
| Konversi, PASS | `arrival-challenges` ✔ | 0/10 → **10/0** | PD | **PASS** |
| Konversi, PASS | `bast-reads`, `bast-signoff`, `bast-writes` ✔ | 0/2 each | PD | **PASS** |
| Konversi, PASS | `customer-payment` ✔ | 0/2 | PD | **PASS** |
| Konversi, PASS | `work-session-reads`, `-close`, `-checkin-start`, `-workclock` ✔ | 0/2 each | PD | **PASS** |
| Konversi, FAIL lanjut | `chargeable-additional-work` ✔ | 0/2 | PD → NOT_AUTHORIZED (lead) | **FAIL, §4.3** |
| Exact-shape, belum dikonversi (20) | `arrival-locations`, `chargeable-additional-work-lead`, `customer-transaction`, `evidence-qc-defect-writes`, `evidence-qc-evidence-reads`, `evidence-qc-evidence-writes`, `evidence-qc-reads`, `evidence-qc-writes`, `execution-scope-assignment-scope-guard`, `execution-scope-assignments`, `geospatial-policies`, `ledger-correction-scope-guard`, `ledger-read-scope-guard`, `payment-allocation-scope-guard`, `scope-assignments-api`, `service-warranty-api-reads-scope-guard`, `service-warranty-claim-scope-guard`, `service-warranty-rework-lead-scope-guard`, `service-warranty-rework-scope-guard`, `service-warranty-scope-guard` | 0–8 PASS, sisanya PD | S1 (PD) | **Belum dikonversi** (§7) |
| Multi-call / manual (5) | `building-scope-guard-part02` (7/2), `customer-care-request-reads` (7/1), `provider-availability` (3/1), `execution-scope` (0/10, 11 panggilan), `customer-care-transport-certification` (1/4, journey) | campuran | S1 + kaskade | **Belum dikonversi** (§7) |

Total: 3 negatif lulus + 10 terkonversi (9 PASS, 1 FAIL lanjut) + 25 belum = 38.

Catatan: `scope-assignments-api` (1/10 awal) sebelumnya dicatat sebagai debt lama. Koreksi: **S1** (9× PD). Sudah dikoreksi di 03H-01 G20.

## 6. Validasi yang dijalankan (dengan PostgreSQL nyata)

Embedded PostgreSQL port 55504, DB baru per run, batas waktu per perintah ≤120 detik. Tidak ada full suite, tidak ada typecheck repo-wide.

| Test | DB | Hasil | Catatan |
|---|---|---|---|
| `handyman-pic-workspace-session` | bersama (`h03h2_a`) | **25/25 PASS** | Membuktikan §3.1. |
| `handyman-pic-workspace-session` | bersih (`h03h2_b`) | **25/25 PASS** | Membuktikan §3.2. |
| `handyman-arrival-challenges` | bersih | **10/10 PASS** | |
| `handyman-bast-reads/signoff/writes` | bersih | **2/2 PASS** masing-masing | |
| `handyman-customer-payment-scope-guard` | bersih | **2/2 PASS** | |
| `handyman-work-session-reads/close/checkin-start/workclock` | bersih | **2/2 PASS** masing-masing | |
| `handyman-chargeable-additional-work-scope-guard` | bersih | **0/2 FAIL** | §4.3, bukan S1. |
| `handyman-pic-portal-decide` (penjaga authority) | bersih | **30/30 PASS** | Tes negatif staff ditutup, PIC decide, rollback, replay. |
| `handyman-quotation-approval-binding-runtime` | bersih | **10/10 PASS** | |
| Inventaris 38 file (sebelum batch 2–3) | DB baru per file | 4 PASS, 34 FAIL | Lihat §5. |

Catatan verifikasi:
- `tsx --test` tidak melakukan type-check. Tipe pada test yang diubah **belum** diverifikasi dengan `tsc`. Pola helper identik dengan yang sudah berjalan di `arrival-challenges`, tetapi ini tetap celah verifikasi (dicatat di §8).
- Tidak ada SKIP pada run di atas (semua DB tersedia).

## 7. Register PART lanjutan

Setiap PART kecil, bisa di-revert sendiri, dan tidak mengubah authority.

| ID | Cakupan | Jumlah | Kategori | Langkah berikutnya |
|---|---|---|---|---|
| **03H-03** | Konversi pola exact-shape: `evidence-qc-*` (5), `service-warranty-*` (5), `ledger-*` (2), `payment-allocation`, `geospatial-policies`, `execution-scope-assignment-scope-guard`, `execution-scope-assignments`, `scope-assignments-api`, `customer-transaction`, `arrival-locations`, `chargeable-additional-work-lead` | 20 | VERIFICATION DEBT (fixture S1) | Batch 4–7 @ ≤5 file per batch, satu DB per file, catat PASS/FAIL |
| **03H-04** | Multi-call / manual: `execution-scope` (11 panggilan), `building-scope-guard-part02`, `customer-care-request-reads`, `provider-availability`, `customer-care-transport-certification` | 5 | VERIFICATION DEBT (fixture + journey) | Perlu desain per file, bukan pola mekanis |
| **G-N1** | `chargeable-additional-work-scope-guard`: propose/accept oleh aktor non-lead | 1 (+1 lead file) | **BLOCKER untuk file itu**, butuh keputusan owner | Owner memutuskan: fixture menetapkan lead, atau aturan propose diubah. Tanpa keputusan, file tetap merah. |
| **G-N2** | Mutation checks dan regresi konsumen `0396`–`0422` | — | VERIFICATION DEBT (dari 03H-01 G13–G14) | Setelah 03H-03/04 selesai |
| **G-N3** | `handyman-material-execution-api` test 6 (`9 !== 8`) belum diklasifikasi ulang | 1 | VERIFICATION DEBT | Jalankan dan klasifikasikan di PART sendiri |

## 8. Gap yang masih terbuka (tidak ditutup oleh turn ini)

- **BLOCKER dari 03H-01 tetap berlaku:** G1 (BLK-GAP-1), G2 (BLK-BIND-BACKFILL), G3 (BLK-3, UNVERIFIED), G4 (BLK-7), G6 (B12 tetap OFF), G7 (BLK-6 sign-off), G8 (BLK-8 TTL), G9 (provisioning TENANT_PIC), G10 (grant `binding.manage`).
- **Verifikasi tipe:** test yang dikonversi belum di-`tsc`. Menjalankan typecheck seluruh repo dilarang untuk turn ini.
- **MC2:** masih belum punya test bernama eksplisit (03H-01 G16).
- **E1–E3 DB guard:** status ratifikasi tetap belum dicatat (03H-01 G17).
- **Staging:** UNVERIFIED. Tidak dapat diakses dari sandbox.

## 9. Keputusan owner dan pointer (tidak diubah)

- **B2-D2 (RATIFIED):** revoke lewat `POST .../approval-binding/revoke`, tanpa alias DELETE. Teks A01 §9 baris 349 masih menulis DELETE. Diserahkan ke pemilik Amendment 01 (lihat 03H-01 §8.1).
- **BLK-10:** deprecation dan successor Link dipertahankan. Tanggal Sunset menunggu jadwal rollout. Tidak ada tanggal yang dikarang.

## 10. Batasan yang dijaga

- Tidak ada perubahan production authority, tidak ada staff approval fallback, tidak ada auto-binding.
- B12 tetap OFF. Tidak ada perubahan historical ledger.
- Tidak ada asersi keamanan yang dilemahkan. Yang berubah hanya fixture, dan asersi jendela waktu yang tidak lagi bergantung pada race.
- Tidak ada klaim E2E CERTIFIED.
