# CR-HM-WO-PG18-UUID-01 — PART 03B2C Delivery Report

**Judul:** PostgreSQL 18 Work Order / Mobile compatibility — penghapusan agregasi `MIN(uuid)`.
**Branch:** `arena/3df97f5e-handyman-backend` (basis PART 03B2B `32f2ba7`).
**Tanggal:** 2026-10-23.
**Status:** selesai; `typecheck` + `build` bersih; seluruh focused test yang diminta hijau kecuali satu
suite yang gagal karena sebab baseline (lihat §5), dan itu dibuktikan dengan menjalankan suite yang sama
pada commit baseline.
Tidak ada PR, tidak ada merge, tidak ada deploy (Railway / Biznet / Coolify), tidak ada full-suite run.

---

## 1. Lokasi bug

| Item | Nilai |
| --- | --- |
| File | `src/modules/mobile-assignments/mobile-assignment.service.ts` |
| Konstanta | `TASK_ASSIGNMENT_SELECT` (dipakai `listMobileAssignments` → `GET /api/v1/mobile/assignments`) |
| Baris (sebelum) | 162 |
| Potongan bermasalah | `CASE WHEN COUNT(*) = 1 THEN MIN(sib_row.id) ELSE NULL END AS active_safety_inspection_binding_id` |
| Tipe kolom | `safety_inspection_bindings.id` bertipe `UUID` (migrasi `0357`) |
| Error | `ERROR 42883: function min(uuid) does not exist` |
| Dampak | seluruh feed assignment Mobile menjawab 500, sehingga suite lifecycle Work Order yang membaca feed (action, completion, BAST closure) gagal |

Error yang sama muncul di laporan baseline:

```
# ... errorMessage=function min(uuid) does not exist path=/api/v1/mobile/assignments method=GET
#     at async Object.listMobileAssignments (src/modules/mobile-assignments/mobile-assignment.service.ts:464)
```

**Verifikasi lingkungan.** Pada PostgreSQL 18.4 (cluster embedded yang dipakai test):

```
MIN(uuid)          -> 42883 function min(uuid) does not exist
MAX(uuid)          -> 42883 function max(uuid) does not exist
MIN(x::text)::uuid -> ok
```

PostgreSQL 18 tidak menyediakan agregat `min`/`max` untuk tipe `uuid` (uuid punya operator btree, tetapi
tidak punya fungsi agregat itu). Karena itu setiap query yang mengagregasi kolom uuid harus diubah, bukan
"diakali" dengan cast yang mengubah makna.

---

## 2. Urutan bisnis yang sebenarnya dibutuhkan

Komentar kode lama menyatakan maksudnya dengan jelas: **`COUNT(*)` adalah penjaga kardinalitas; id hanya
diekspos bila tepat satu binding ACTIVE ada**. Jadi yang dibutuhkan bukan "id mana saja", melainkan:

1. hitung binding ACTIVE untuk schedule definition task tersebut;
2. bila jumlahnya **tepat satu**, marker = id binding itu;
3. bila **nol**, marker = `NULL`;
4. bila **lebih dari satu** (tidak mungkin terjadi karena migrasi `0357` memasang unique partial index
   `safety_inspection_bindings_schedule_active_unique`), marker tidak boleh dipilih sembarang — service
   tetap melempar `safetyInspectionBindingAmbiguousError()`.

Tidak ada kebutuhan "pilih yang terkecil/terbesar secara arbitrer". `MIN(uuid)` sendiri bukan ekspresi
urutan bisnis, melainkan cara lama meminjam agregat untuk mengambil satu nilai tanpa memikirkan urutan.

---

## 3. Perbaikan

### 3.1 Query (deterministik, tanpa winner acak)

Penghitungan kardinalitas dipisah dari pengambilan id:

```sql
  -- Cardinality guard (tidak berubah)
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::INTEGER AS active_safety_inspection_binding_count
      FROM safety_inspection_bindings sib_row
     WHERE sib_row.schedule_definition_id = t.schedule_definition_id
       AND sib_row.status = 'ACTIVE'
  ) sib ON TRUE

  -- Marker: ORDER BY + LIMIT 1, hanya berlaku saat kardinalitas = 1
  LEFT JOIN LATERAL (
    SELECT sib_one.id AS active_safety_inspection_binding_id
      FROM safety_inspection_bindings sib_one
     WHERE sib_one.schedule_definition_id = t.schedule_definition_id
       AND sib_one.status = 'ACTIVE'
     ORDER BY sib_one.created_at ASC, sib_one.id ASC
     LIMIT 1
  ) sib_id ON sib.active_safety_inspection_binding_count = 1
```

Sifat yang dipertahankan:

- **Deterministik**: urutan eksplisit `created_at ASC, id ASC`; `id` unik sehingga urutannya total (tidak
  ada tie yang ambigu).
- **Bukan pemilihan acak**: bila kardinalitas ≠ 1, join tidak match → `NULL`, sama seperti `CASE ... ELSE NULL`
  sebelumnya.
- **Guard ambiguitas tetap ada**: `toTaskItem` masih memeriksa `active_safety_inspection_binding_count > 1`
  dan menolak item, jadi tidak ada "pemenang" yang diam-diam dipilih.
- **Bentuk respons tidak berubah**: kolom `active_safety_inspection_binding_id` dan
  `active_safety_inspection_binding_count` tetap ada dengan nama dan tipe yang sama, sehingga
  `reference.safetyInspectionBindingId` pada feed Mobile tidak berubah kontrak.
- **Client/Building scope, RBAC, assignment authority, urutan pekerjaan, dan transaksi tidak disentuh**:
  perubahan hanya pada fragmen SELECT; `TASK_ASSIGNMENT_SCOPE` (Building/Client + assignee) dan
  `ORDER BY t.occurrence_at, a.id` tetap, dan tidak ada perubahan pada jalur Work Order assignment/competency
  (business rule Multi-Skill Worker PART 03B2B tetap lulus).

### 3.2 Audit seluruh agregasi UUID di backend

Seluruh pemakaian `MIN(` / `MAX(` di `src/**` diperiksa terhadap tipe kolomnya:

| Agregat | Kolom | Tipe | Status |
| --- | --- | --- | --- |
| `MIN(sib_row.id)` | `safety_inspection_bindings.id` | **uuid** | **diperbaiki (PART ini)** |
| `MIN(c.commitment_id::text)::uuid`, `MIN(binding.id::text)::uuid` | `operational-variance.repository.ts` | text → uuid | kompatibel (agregat dijalankan pada `text`) |
| `MIN(c.uom_id::text)::uuid` | `utility-aggregation.repository.ts` | text → uuid | kompatibel |
| `MIN/MAX(...attempt_number, version_number, line_number, revision_number, occurrence_index, lead_seq)` | berbagai repository | numeric/integer | kompatibel |
| `MIN/MAX(...period_start, period_end, created_at, updated_at, occurred_at, reviewed_at)` | berbagai repository | timestamptz/date | kompatibel |
| `MAX(fs.rank)`, `SUM/AVG(...)` | berbagai repository | numeric | kompatibel |

Tidak ditemukan lagi agregat `MIN`/`MAX` atas kolom uuid (tanpa cast) di seluruh `src/**`, termasuk di
jalur Work Order register, action, completion, dan BAST closure (modul-modul itu tidak memakai agregasi uuid).

---

## 4. Regression test baru

File: `tests/work-order-pg18-03b2c.test.ts` — cluster PostgreSQL embedded **18.4** di
`/tmp/hm-pg18-03b2c-pg` (port `55664`), migrasi dari nol.

| # | Test | Isi |
| --- | --- | --- |
| P1 | "refuses MIN(uuid) and MAX(uuid) with 42883" | Membuktikan database uji benar-benar PostgreSQL 18 dengan semantik uuid: `MIN(uuid)`/`MAX(uuid)` ditolak kode `42883`, sementara bentuk pengganti (`ORDER BY ... LIMIT 1`) berjalan |
| P2-a | marker = binding ACTIVE tunggal | Feed Mobile mengembalikan `reference.safetyInspectionBindingId` yang tepat |
| P2-b | tanpa binding ACTIVE | marker `null` |
| P2-c | hanya binding INACTIVE | marker `null` |
| P2-d | determinisme + guard kardinalitas | tiga pembacaan feed memberi marker yang sama; insert binding ACTIVE kedua ditolak `23505` (unique partial index), sehingga tidak pernah butuh winner selection |
| P3 | static guard | `mobile-assignment.service.ts` tidak lagi memuat pola `MIN/MAX(<alias>.id)` pada SQL yang dieksekusi, dan marker diproyeksikan dari lateral `ORDER BY ... LIMIT 1` |

Hasil: `# tests 6 — # pass 6 — # fail 0`.

---

## 5. Focused test results (PostgreSQL 18 embedded, database disposable)

| Suite | Sebelum (baseline `32f2ba7`) | Sesudah PART 03B2C |
| --- | --- | --- |
| `tests/work-order-action.test.ts` | gagal: `/mobile/assignments` 500 `min(uuid)` | **16/16 pass** |
| `tests/work-order-completion.test.ts` | gagal: 500 yang sama | **12/12 pass** |
| `tests/work-order-bast-closure-part04.test.ts` | 2 gagal (turunan error yang sama) | **10/10 pass** |
| `tests/work-order-register.test.ts` | 6 pass / 6 fail | **6 pass / 6 fail (tidak berubah — baseline)** |
| `tests/mobile-assignment-contract.test.ts` | — | **18/18 pass** |
| `tests/mobile-assignment-shift-context.test.ts` | — | **16/16 pass** |
| `tests/handyman-competency-assignment.test.ts` (PART 03A, kompetensi) | — | **11/11 pass** |
| `tests/work-order-pg18-03b2c.test.ts` (baru) | — | **6/6 pass** |

### Kegagalan baseline yang **bukan** disebabkan perubahan ini

`tests/work-order-register.test.ts` tetap 6 gagal. Penyebabnya asumsi volume/urutan data lama
(`expected: 3, actual: 5`; `expected: 12, actual: 3`; perbandingan id yang berbeda), bukan error uuid dan bukan
jalur Mobile. Dibuktikan dengan menjalankan **suite yang sama pada commit baseline `32f2ba7`** (perubahan
PART ini di-stash): hasilnya identik — **6 pass / 6 fail**. Suite itu juga tidak memuat `MIN`/`MAX` sama sekali.

---

## 6. Gerbang kualitas

| Perintah | Hasil |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |
| `tests/openapi-contract.test.ts` + `tests/handyman-contract-freeze-03-openapi.test.ts` (focused OpenAPI parity) | 20/20 pass |

Tidak ada perubahan kontrak OpenAPI pada PART ini (murni perbaikan query), sehingga paritas runtime/OpenAPI
tidak berubah: 2.014 operasi, tanpa route baru.

---

## 7. Catatan dan batasan

- Tidak ada perubahan business rule. Penegakan kompetensi multi-skill (PART 03B2B) tetap utuh dan lulus
  (`handyman-competency-assignment` 11/11, dan suite 03B2B/03B2A tidak disentuh).
- Perbaikan hanya menyentuh satu fragmen SQL; tidak ada migration baru (tidak diperlukan — tipe data tidak
  berubah, hanya cara membaca).
- `MIN(x::text)::uuid` pada modul finance/utility dibiarkan apa adanya karena kompatibel dengan PostgreSQL 18
  dan sudah menjadi bentuk yang disengaja di modul tersebut. Bila nanti dirapikan menjadi `ORDER BY ... LIMIT 1`,
  itu pekerjaan kosmetik terpisah, bukan bug.

---

## 8. Cara mereproduksi

```bash
cd /home/user/Handyman-Backend
npm run typecheck
npm run build
NODE_ENV=test LOG_LEVEL=error npx tsx --test --test-concurrency=1 tests/work-order-pg18-03b2c.test.ts
NODE_ENV=test LOG_LEVEL=error npx tsx --test --test-concurrency=1 tests/work-order-action.test.ts
NODE_ENV=test LOG_LEVEL=error npx tsx --test --test-concurrency=1 tests/work-order-completion.test.ts
NODE_ENV=test LOG_LEVEL=error npx tsx --test --test-concurrency=1 tests/work-order-bast-closure-part04.test.ts
```
