# CR-HM-WORKER-COMPETENCY-01 — PART 03B2B Delivery Report

**Judul:** Koreksi business rule — **MULTI-SKILL WORKER**, bukan "one worker = one trade".
**Branch:** `arena/3df97f5e-handyman-backend` (basis PART 03B2A `06933e4`).
**Tanggal:** 2026-10-23.
**Status:** selesai; `typecheck` + `build` bersih; 11/11 test PART 03B2B hijau dan 42/42 test
kompetensi terkait (03B2B + 03B2A + 03A + 03B1) tetap hijau.
Tidak ada PR, tidak ada merge, tidak ada deploy (termasuk Coolify).

---

## 1. Ringkasan

Model bisnis Handyman adalah **multi-skill worker**: satu pekerja boleh memegang beberapa skill dan
beberapa sertifikat dari kategori pekerjaan berbeda, dan Operations boleh menugaskannya ke pekerjaan apa pun
— teknisi AC boleh ditugaskan ke electrical minor, plumbing, furniture, atau pengecatan. PART 03B2B
memastikan tidak ada satu pun aturan yang menurunkan "boleh/tidaknya" seorang pekerja dari trade sertifikat
atau trade pertamanya, lalu menutup dua cacat isolasi antar-Client yang justru muncul saat aturan ini diuji.

Hasil audit kode: **gerbang penegakan PART 03B2A memang sudah sepenuhnya requirement-driven** (tidak ada
perbandingan trade pekerja vs trade Work Order), tetapi pengujian multi-skill menemukan **dua bug isolasi
Client** yang harus diperbaiki agar aturan ini benar-benar berjalan:

1. **Unique index requirement per trade tidak menyertakan `client_id`** — Client B tidak bisa mengonfigurasi
   requirement yang sama dengan Client A pada trade yang sama (409 palsu), dan secara struktural melanggar
   isolasi tenant.
2. **Probe duplikat requirement tidak memfilter `client_id`** — create requirement di Client B ditolak
   karena membaca baris milik Client A, meskipun index sudah diperbaiki.

Keduanya diperbaiki. Ditambah satu perbaikan UX yang diminta aturan 6: **warning RECOMMENDED kini tampil pada
respons assignment**, bukan hanya tersimpan di ledger.

---

## 2. Audit: apa yang diperiksa dan hasilnya

| Yang diperiksa | Hasil |
| --- | --- |
| `work-order-assignment.service.ts` — apakah ada aturan `trade pekerja == trade WO` | Tidak ada. Subjek yang dievaluasi hanya ditentukan oleh `assigneeType` (WORKFORCE/ TEAM/ VENDOR_WORKFORCE/ VENDOR), bukan oleh trade atau sertifikat |
| `worker-competency-eligibility.service.ts` — pencocokan requirement | Hanya dari requirement ACTIVE milik trade Work Order + Client Work Order (`listActiveByTradeCategory(executor, tradeCategoryId, clientId)`) |
| Pencocokan sertifikat | Nama sertifikat dinormalisasi (`normalizeCertificateName`) + opsional narrowing `skillId`; status `ACTIVE`, `VERIFIED`, dan belum kedaluwarsa |
| Apakah trade/discipline dipakai di jalur assignment | Tidak. `handyman_discipline_id` hanya dipakai pada diagnosis/referral Service Request, tidak pada eligibility pekerja |
| Perilaku trade tanpa requirement | `satisfied: true`, `rows: []`, tidak menulis ledger — assignment lolos |
| Perilaku RECOMMENDED | Hanya masuk `advisory`; penolakan hanya dari `MANDATORY` |
| Isolasi Client pada konfigurasi requirement | Ditemukan 2 cacat (lihat §1) → diperbaiki di PART ini |
| Kemandirian keputusan Operations | Backend hanya memvalidasi requirement wajib; tidak ada endpoint/flag yang mengubah keputusan Operations |

**Kesimpulan:** aturan 1, 2, 3, 4, 5, 7, 9, 10, 11 sudah terpenuhi secara desain; aturan 6 (warning) dan
isolasi Client perlu perbaikan konkret, dan keduanya dikerjakan di PART ini.

---

## 3. Perubahan

### 3.1 Warning RECOMMENDED pada respons assignment (aturan 6)

Respons `POST /work-orders/:id/assignments` dan `PATCH /work-orders/:id/assignments/:assignmentId`
(reassignment) kini membawa objek aditif `data.competency`:

```json
{
  "id": "…",
  "assigneeType": "WORKFORCE",
  "competency": {
    "tradeCategoryId": "…",
    "tradeCategoryCode": "ELECTRICAL_MINOR",
    "rule": "ALL",
    "satisfied": true,
    "mandatoryRequirementCount": 0,
    "advisory": [
      {
        "workforceProfileId": "…",
        "workforceProfileName": "Worker 3F2A",
        "requirementId": "…",
        "requirementType": "SKILL",
        "skillCode": "SK_ELEC_9A1B",
        "certificateName": null,
        "minimumProficiencyLevel": "INTERMEDIATE",
        "reason": "SKILL_MISSING"
      }
    ]
  }
}
```

Sifat kontrak:

- `satisfied` **selalu** `true` pada respons 2xx — gap MANDATORY adalah 409, bukan 200 dengan peringatan.
- `advisory` boleh berisi banyak entri (satu per pekerja per requirement) — misalnya satu warning per anggota
  team.
- Field ini **tidak ada** pada pembacaan biasa (`GET .../assignments`, `GET .../assignments/current`),
  sehingga payload lama tidak berubah bentuk (backward compatible).
- Warning juga tetap dapat dibaca ulang dari ledger:
  `GET /work-orders/:id/assignments/competency-decisions` (baris `enforcementLevel: RECOMMENDED`,
  `satisfied: false`).

### 3.2 Perbaikan isolasi Client (ditemukan oleh test multi-skill)

- Migrasi `0465` **diamandemen** (PART 03B2A belum pernah dideploy, sehingga migrasi yang sama diperbaiki
  langsung alih-alih menambah migrasi koreksi): unique index requirement per trade kini menyertakan `client_id`
  (`service_catalog_competency_requirements_trade_skill_unique`,
  `..._trade_cert_unique`). Dua tenant boleh mengonfigurasi requirement yang sama pada trade yang sama
  tanpa saling menimpa atau saling menolak.
- `service-competency-requirement.repository.ts`: `findActiveSkillRequirement` dan
  `findActiveCertificationRequirement` kini menerima dan memfilter `clientId`; service meneruskan Client
  yang sudah diotorisasi. Tanpa ini, create requirement Client B membaca baris Client A → 409 palsu.

### 3.3 OpenAPI

`WorkOrderAssignment` mendapat properti aditif `competency` (nullable), dua skema baru
`WorkOrderAssignmentCompetencyOutcome` dan `WorkOrderAssignmentCompetencyWarning`, serta penjelasan eksplisit
pada `assignWorkOrder` bahwa model yang berlaku adalah multi-skill worker dan hanya requirement MANDATORY
yang dapat menolak. Tidak ada route baru; jumlah operasi tetap 2.014 dan paritas runtime tidak berubah.

### 3.4 Tidak ada perubahan yang melemahkan penegakan

- Tidak ada flag/kolom bypass, tidak ada "soft mode", tidak ada pengecualian per role.
- Field asing pada body assignment (`bypassCompetency`, `enforceCompetency: false`, `competencyOverride`,
  `ignoreMandatoryRequirements`) **diabaikan** oleh validator dan tidak berpengaruh: gerbang selalu membaca
  requirement dari database (dibuktikan test B7).
- Lifecycle assignment, satu assignment ACTIVE per Work Order, `withTransaction` + rollback, event history,
  ledger append-only, RBAC, dan Client/Building scope tidak berubah.

---

## 4. Regression test (file baru `tests/work-order-multiskill-03b2b.test.ts`)

Cluster PostgreSQL embedded sendiri (`/tmp/hm-multiskill-03b2b-pg`, port `55663`), migrasi dari nol, tanpa
TRUNCATE (agar seed registry trade tidak hilang).

| Test | Skenario | Ekspektasi | Hasil |
| --- | --- | --- | --- |
| B1 | Pekerja bersertifikat AC → Work Order **electrical minor** tanpa requirement | **ALLOWED** (201), `mandatoryRequirementCount = 0`, `advisory = []`, 0 baris ledger, sertifikat AC utuh | PASS |
| B2 | Pekerja bersertifikat AC → Work Order **plumbing** tanpa requirement | **ALLOWED** (201) — termasuk saat rekan satu Client memegang sertifikat plumbing (kredensial orang lain tidak dipinjam) | PASS |
| B3 | Pekerja AC → electrical dengan **RECOMMENDED skill** belum dipenuhi | **ALLOWED + WARNING**: 201, `advisory[0].skillCode` sesuai, `reason = SKILL_MISSING`; ledger `enforcementLevel = RECOMMENDED`, `satisfied = false`; warning terbaca lewat endpoint ledger | PASS |
| B4 | Pekerja AC (skill EXPERT) → electrical dengan **MANDATORY electrical certification** belum dipenuhi | **DENIED** 409 `WORK_ORDER_ASSIGNMENT_COMPETENCY_REQUIRED`, `reason = CERTIFICATION_MISSING`; 0 assignment, 0 baris ledger, 0 event `WORK_ORDER_ASSIGNED` | PASS |
| B5 | Pekerja **multi-skill** (sertifikat AC + sertifikat kelistrikan + skill plumbing ADVANCED) → electrical dengan 2 requirement MANDATORY | **ALLOWED**, `mandatoryRequirementCount = 2`, 2 baris ledger `satisfied = true` | PASS |
| B6 | Sertifikat kategori lain (AC) + skill electrical EXPERT tidak menggantikan sertifikat wajib spesifik | **DENIED** `CERTIFICATION_MISSING` dengan nama sertifikat yang diminta | PASS |
| B7 | Kewajiban keselamatan (sertifikat K3 kelistrikan) + upaya bypass (`bypassCompetency`, `enforceCompetency: false`, `competencyOverride`, `ignoreMandatoryRequirements`) | **DENIED** 409; satu-satunya jalan adalah sertifikatnya (setelah diberi → 201) | PASS |
| B8 | Tidak ada aturan trade: pekerja AC yang **memiliki** skill plumbing → plumbing MANDATORY skill = ALLOWED; pekerja AC tanpa skill plumbing pada trade yang sama = DENIED dengan `skillCode` requirement | Membuktikan penolakan bersumber dari requirement, bukan dari trade | PASS |
| B9 | Team 2 pekerja AC → electrical dengan RECOMMENDED skill | 201, `rule = ALL`, `advisory.length = 2` (satu per anggota) | PASS |
| B10 | Lifecycle tetap utuh: assign → current → reassign → ledger kosong, event `WORK_ORDER_ASSIGNED`/`WORK_ORDER_REASSIGNED` masing-masing 1, hanya satu assignment ACTIVE | Tidak ada regresi siklus hidup & riwayat keputusan | PASS |

Perintah dan hasil:

```bash
NODE_ENV=test LOG_LEVEL=error npx tsx --test --test-concurrency=1 tests/work-order-multiskill-03b2b.test.ts
# # tests 11   # pass 11   # fail 0
```

Regresi kompetensi terkait (semua hijau, dijalankan ulang setelah perubahan):

| Suite | Hasil |
| --- | --- |
| `tests/work-order-multiskill-03b2b.test.ts` (baru) | 11/11 |
| `tests/work-order-multitrade-03b2a.test.ts` | 17/17 |
| `tests/handyman-competency-assignment.test.ts` (PART 03A) | 11/11 |
| `tests/worker-competency-03b1.test.ts` (PART 03B1) | 14/14 |
| `tests/openapi-contract.test.ts` | 7/7 |
| `tests/handyman-contract-freeze-03-openapi.test.ts` | 20/20 |

Gerbang kualitas: `npm run typecheck` exit 0, `npm run build` exit 0.

---

## 5. Pemetaan aturan yang diminta

| # | Aturan | Status | Bukti |
| --- | --- | --- | --- |
| 1 | Pekerja boleh punya banyak skill & sertifikat dari kategori berbeda | Terpenuhi | B1, B5 (satu pekerja: AC + kelistrikan + plumbing) |
| 2 | Sertifikat AC tidak membatasi pekerja hanya pada pekerjaan AC | Terpenuhi | B1, B2, B3 |
| 3 | Operations boleh menugaskan teknisi AC ke electrical minor, plumbing, furniture, painting, dll. | Terpenuhi | B1, B2, B8 (tidak ada aturan trade) |
| 4 | Tidak adanya sertifikat pada suatu kategori bukan alasan otomatis menolak | Terpenuhi | B1, B2 (0 requirement → 0 penolakan) |
| 5 | Pekerjaan tanpa MANDATORY requirement tetap boleh di-assign | Terpenuhi | B1, B2, B10 |
| 6 | RECOMMENDED yang belum terpenuhi = warning, bukan blokir | Terpenuhi | B3, B9 (`data.competency.advisory`) |
| 7 | Skill/sertifikasi MANDATORY hanya boleh jika requirement terpenuhi | Terpenuhi | B4, B5, B7 |
| 8 | Sertifikat kategori lain tidak menggantikan sertifikat wajib spesifik | Terpenuhi | B6 |
| 9 | Sertifikasi wajib karena keselamatan/regulasi tidak dapat di-bypass | Terpenuhi | B7 |
| 10 | Tidak boleh ada hardcoded rule trade pekerja == trade Work Order | Terpenuhi | B8 + audit §2 |
| 11 | Keputusan akhir di Operations, backend hanya memvalidasi requirement wajib | Terpenuhi | Gate hanya menolak bila MANDATORY tidak terpenuhi; tidak ada override/bypass |

---

## 6. Gap yang masih terbuka (tidak berubah karena PART ini)

Sama dengan laporan PART 03B2A, dengan catatan tambahan:

- **G1 — penugasan tingkat VENDOR** tetap memakai aturan ANY atas worker terikat (perusahaan tidak menunjuk
  orang). Ini bukan pelanggaran model multi-skill, tetapi perlu kebijakan governance tersendiri.
- **G2 — requirement per Building** belum ada (masih per trade per Client).
- **G3 — `risk_level` masih deskriptif**, belum menurunkan requirement otomatis.
- **G4 — klasifikasi Work Order belum wajib**, sehingga Work Order berisiko tinggi bisa lolos tanpa gate bila
  Operations lupa mengklasifikasi.
- **G5 — belum ada jalur exception ber-approval** (dan ini memang disengaja: aturan 9 melarang bypass
  otomatis; bila nanti dibutuhkan, harus berupa alur persetujuan eksplisit dengan audit).
- **G6 — bulk konfigurasi requirement & handoff UI** (termasuk menampilkan `competency.advisory` pada modal
  assign) belum dibuat.
- **G7 — retensi ledger** `work_order_assignment_competency_decisions` belum ditetapkan.
- **G8 — sweeper kedaluwarsa sertifikat** masih belum ada (dihitung saat dibaca).
- **G9 — read model kandidat per Work Order** belum ada; UI baru bisa melihat warning setelah assignment.

---

## 7. Cara mereproduksi

```bash
cd /home/user/Handyman-Backend
npm run typecheck
npm run build
NODE_ENV=test LOG_LEVEL=error npx tsx --test --test-concurrency=1 tests/work-order-multiskill-03b2b.test.ts
```
