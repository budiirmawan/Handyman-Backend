# CR-HM-WORKER-COMPETENCY-01 — PART 04A — Handoff Frontend **Operations**

**Branch:** `arena/3df97f5e-handyman-backend`
**Basis runtime:** `d4a7aa3` (PART 03B2E) + perubahan PART 04A
**Tanggal:** 2026-10-23
**Sifat dokumen:** kontrak integrasi untuk aplikasi Operations. Semua endpoint di bawah ini **sudah ada**
di runtime dan sudah diverifikasi lewat HTTP pada `tests/e2e-operational-lifecycle-04a.test.ts` (16/16).

---

## 0. Aturan dasar yang tidak boleh dilanggar UI

| # | Aturan | Konsekuensi untuk UI |
| --- | --- | --- |
| 1 | Trade **bukan** input Customer Care. Request Tenant masuk sebagai **free text** (`requestType`), tanpa Service Catalog dan tanpa trade. | Jangan menampilkan dropdown trade di form intake Tenant/Customer Care. |
| 2 | Trade adalah **keputusan Operations** (`PATCH /work-orders/{id}/classification`). | Layar klasifikasi wajib ada sebelum tombol "Assign". |
| 3 | Work Order yang berasal dari Customer Care **tidak boleh** di-assign sebelum diklasifikasi (`409 WORK_ORDER_CLASSIFICATION_REQUIRED`), dan penolakan itu **tidak menulis apa pun**. | Jangan menawarkan daftar pekerja sebelum klasifikasi sukses. |
| 4 | Assignment adalah **satu otoritas**: `work_order_assignments` (POST/PATCH di bawah). Tidak ada jalur assign kedua. | Jangan memakai endpoint lain (crew/execution-scope) untuk menugaskan Work Order. |
| 5 | Pekerja Handyman (INTERNAL / CONTRACT / FREELANCE) ditugaskan **langsung**, tanpa vendor dan tanpa vendor fiktif. | Vendor hanya untuk pekerjaan subkontrak nyata (`assigneeType: VENDOR` / `VENDOR_WORKFORCE`). |
| 6 | Worker bersifat **multi-skill**: sertifikat/skill trade lain tidak boleh menyebabkan penolakan, substitusi, atau filter. | Jangan menyaring daftar pekerja berdasarkan trade tunggal. |
| 7 | Hanya requirement `MANDATORY` yang memblokir. `RECOMMENDED` hanya **warning**. | Tampilkan warning sebagai advisory, bukan error. |
| 8 | Setiap operasi **Client/Building-scoped**. Permission luas tidak memperlebar akses. | Tangani `403 BUILDING_ACCESS_DENIED` sebagai "di luar scope", bukan "tidak ada data". |

---

## 1. Alur layar Operations (klasifikasi → pemilihan pekerja → assignment)

```
Work Order (OPEN, unclassified)
   │  GET  /work-orders/{id}/classification          → classificationRequired = true
   ├─▶ Layar Klasifikasi
   │     GET  /work-order-trade-categories           → daftar trade (+ default risk)
   │     GET  /work-order-trade-categories/{tradeId}/competency-requirements?clientId=…
   │     PATCH /work-orders/{id}/classification      { tradeCategoryId, riskLevel }
   │        ├─ 409 WORK_ORDER_TRADE_CATEGORY_INVALID_STATE  → WO sudah COMPLETED/CLOSED/CANCELLED
   │        └─ 409 WORK_ORDER_CLASSIFICATION_CONFLICT       → WO sedang dipegang pekerja yang tidak memenuhi MANDATORY trade baru
   ├─▶ Layar Pemilihan Pekerja
   │     GET  /organizations/{organizationId}/workforce-profiles
   │                                                 → pekerja + employmentType (INTERNAL/CONTRACT/FREELANCE)
   │       (varian: GET /departments/{departmentId}/workforce-profiles,
   │                 GET /teams/{teamId}/workforce-profiles; permission workforce.read)
   │     POST /work-orders/{id}/assignments           { assigneeType: 'WORKFORCE', workforceProfileId }
   │        ├─ 201 + data.competency.advisory[]       → sukses, warning bila ada RECOMMENDED yang tidak terpenuhi
   │        └─ 409 WORK_ORDER_ASSIGNMENT_COMPETENCY_REQUIRED + details[]
   └─▶ Monitoring
         GET  /work-orders/{id}/assignments/current
         GET  /work-orders/{id}/assignments
         PATCH /work-orders/{id}/assignments/{assignmentId}   (reassign / deactivate)
         GET  /work-orders/{id}/assignments/competency-decisions
```

---

## 2. Klasifikasi

### 2.1 `GET /work-orders/{workOrderId}/classification` — `work_order.read`, building-scoped

| Field | Tipe | Arti |
| --- | --- | --- |
| `workOrderId` | uuid | Work Order |
| `clientId` / `buildingId` | uuid | Scope |
| `tradeCategoryId` | uuid \| null | `null` = belum diklasifikasi |
| `tradeCategoryCode` | string \| null | `PLUMBING`, `PAINTING`, `SANITARY`, `FURNITURE`, `ELECTRICAL_MINOR`, `GENERAL_REPAIR`, … |
| `tradeCategoryName` | string \| null | label |
| `riskLevel` | `LOW` \| `MEDIUM` \| `HIGH` \| null | turunan default trade, bisa dioverride per job |
| `classifiedAt` / `classifiedByUserId` | ISO \| null / uuid \| null | siapa & kapan |
| `classificationRequired` | boolean | **derived** dari adanya binding Customer Care; `true` = WO ini masih berutang keputusan Operations |

`classificationRequired` **bukan** kolom yang harus disetel UI. Nilainya turunan dari
`tenant_service_requests.work_order_id` / `work_request_id`, jadi tidak bisa "lupa disetel".

### 2.2 `PATCH /work-orders/{workOrderId}/classification` — `work_order.manage`, building-scoped

```json
{ "tradeCategoryId": "<uuid>", "riskLevel": "MEDIUM" }
```

* `riskLevel` opsional → default dari `work_order_trade_categories.default_risk_level`.
* `tradeCategoryId: null` **ditolak** bila WO masih punya assignment ACTIVE
  (`WORK_ORDER_CLASSIFICATION_CONFLICT` / clear-blocked) — jangan sediakan tombol "hapus klasifikasi"
  pada WO yang sedang berjalan.
* Reklasifikasi pada WO yang **sudah di-assign** akan **direvalidasi** terhadap pekerja aktif:
  bila trade baru punya requirement `MANDATORY` yang tidak dipenuhi, seluruh perubahan di-rollback.
* Sukses = 200 dengan payload yang sama seperti 2.1 (`tradeCategoryCode` sudah terisi).
* Ledger keputusan mendapat baris `action = 'RECLASSIFIED'` bila ada assignment ACTIVE.

### 2.3 Master trade category

| Method & path | Permission | Catatan |
| --- | --- | --- |
| `GET /work-order-trade-categories` | `work_order.read` | filter `status`, `riskLevel`, `handymanDisciplineId` |
| `POST /work-order-trade-categories` | `work_order.manage` | 409 `WORK_ORDER_TRADE_CATEGORY_ALREADY_EXISTS` |
| `GET /work-order-trade-categories/{id}` | `work_order.read` | |
| `PATCH /work-order-trade-categories/{id}` | `work_order.manage` | |
| `POST /work-order-trade-categories/{id}/deactivate` | `work_order.manage` | non-destruktif |

### 2.4 Requirement kompetensi per trade (client-scoped, `?clientId=` wajib)

| Method & path | Permission |
| --- | --- |
| `GET /work-order-trade-categories/{tradeId}/competency-requirements?clientId=` | `work_order.read` |
| `POST /work-order-trade-categories/{tradeId}/competency-requirements?clientId=` | `work_order.manage` |
| `GET /work-order-trade-categories/{tradeId}/competency-requirements/{requirementId}?clientId=` | `work_order.read` |
| `PATCH …/{requirementId}?clientId=` | `work_order.manage` |
| `POST …/{requirementId}/deactivate?clientId=` | `work_order.manage` |

Body `POST`/`PATCH`:

| Field | Nilai |
| --- | --- |
| `requirementType` | `SKILL` \| `CERTIFICATION` |
| `enforcementLevel` | `MANDATORY` (memblokir) \| `RECOMMENDED` (hanya warning) |
| `skillId` | wajib untuk `SKILL` |
| `minimumProficiencyLevel` | `BASIC` \| `INTERMEDIATE` \| `ADVANCED` \| `EXPERT` |
| `certificateName` | wajib untuk `CERTIFICATION` (dicocokkan ke nama sertifikat pekerja) |
| `serviceCatalogId` | opsional (`null` = berlaku untuk seluruh trade) |

Filter query list: `status`, `enforcementLevel`, `requirementType`.
Error penting: `SERVICE_COMPETENCY_REQUIREMENT_SKILL_MISMATCH`, `BUILDING_ACCESS_DENIED`,
`WORK_ORDER_TRADE_CATEGORY_NOT_FOUND`.

> **Catatan produk:** untuk pekerja multi-skill jangan pernah mengisi requirement `MANDATORY` sebagai
> "semua trade yang pernah dikerjakan". Isi hanya yang benar-benar wajib menurut risiko pekerjaan.

---

## 3. Pemilihan pekerja & assignment

### 3.1 `POST /work-orders/{workOrderId}/assignments` — `work_order.manage`, building-scoped

```json
{ "assigneeType": "WORKFORCE", "workforceProfileId": "<uuid>" }
```

`assigneeType`: `WORKFORCE` \| `TEAM` \| `VENDOR` \| `VENDOR_WORKFORCE`.
Untuk pekerja Handyman sendiri (tetap/kontrak/freelance) **selalu** `WORKFORCE` + `workforceProfileId`.

Respons `201`:

```json
{
  "id": "<assignmentId>",
  "workOrderId": "<uuid>",
  "assigneeType": "WORKFORCE",
  "workforceProfileId": "<uuid>",
  "teamId": null,
  "vendorId": null,
  "assignedByUserId": "<uuid>",
  "assignedAt": "2026-10-23T03:00:00.000Z",
  "status": "ACTIVE",
  "competency": {
    "tradeCategoryId": "<uuid>",
    "tradeCategoryCode": "PLUMBING",
    "rule": "ALL",
    "satisfied": true,
    "mandatoryRequirementCount": 0,
    "advisory": []
  }
}
```

`advisory[]` (hanya untuk requirement `RECOMMENDED` yang tidak terpenuhi):

```json
{
  "workforceProfileId": "<uuid>",
  "workforceProfileName": "Technician 344A7171",
  "requirementId": "<uuid>",
  "requirementType": "SKILL",
  "skillCode": "SK_PAINT",
  "certificateName": null,
  "minimumProficiencyLevel": "BASIC",
  "reason": "SKILL_MISSING"
}
```

Aturan rule yang dipakai engine (jangan direplikasi di UI, cukup ditampilkan):

* `WORKFORCE` / `TEAM` → `ALL` (setiap subjek harus memenuhi).
* `VENDOR` → `ANY` (minimal satu subjek memenuhi).
* `VENDOR_WORKFORCE` → dievaluasi sebagai individu.

**Penolakan `409 WORK_ORDER_ASSIGNMENT_COMPETENCY_REQUIRED`** — payload `error.details[]`:

```json
{
  "workforceProfileId": "<uuid>",
  "workforceProfileName": "Technician 344A7171",
  "requirementId": "<uuid>",
  "requirementType": "CERTIFICATION",
  "enforcementLevel": "MANDATORY",
  "skillCode": null,
  "certificateName": "Sertifikat Plumbing",
  "minimumProficiencyLevel": null,
  "reason": "CERTIFICATION_MISSING",
  "rule": "ALL"
}
```

`reason` yang mungkin: `SKILL_MISSING`, `SKILL_PROFICIENCY_BELOW_MINIMUM`, `SKILL_EXPIRED`,
`CERTIFICATION_MISSING`, `CERTIFICATION_UNVERIFIED`, `CERTIFICATION_EXPIRED`.

Penolakan ini **atomik**: tidak ada baris `work_order_assignments`, tidak ada baris ledger.

### 3.2 Reassign & deactivate — `PATCH /work-orders/{id}/assignments/{assignmentId}`

| Body | Efek |
| --- | --- |
| `{ "assigneeType": "WORKFORCE", "workforceProfileId": "<uuid>" }` | reassign: assignment lama → `INACTIVE`, satu assignment baru `ACTIVE`, ledger `action = 'REASSIGNED'` |
| `{ "status": "INACTIVE" }` | deaktivasi assignment tersebut |

Reassign **juga** melewati gate kompetensi (termasuk klasifikasi wajib). Reassign yang gagal
meninggalkan assignment lama tetap `ACTIVE` — UI tidak boleh menutup panel sebelum respons sukses.

### 3.3 Read model

| Endpoint | Permission | Isi |
| --- | --- | --- |
| `GET /work-orders/{id}/assignments/current` | `work_order.read` | assignment ACTIVE (atau `null`) |
| `GET /work-orders/{id}/assignments` | `work_order.read` | riwayat lengkap (ACTIVE + INACTIVE) |
| `GET /work-orders/{id}/assignments/competency-decisions` | `work_order.read` | ledger append-only |

Filter ledger: `action` (`ASSIGNED` \| `REASSIGNED` \| `RECLASSIFIED`), `assignmentId`,
`workforceProfileId`, `satisfied`, `enforcementLevel`, `page`, `pageSize`.
Kolom ledger yang bisa dipakai UI audit: `requirement_type`, `enforcement_level`, `satisfied`,
`reason`, `evidence_proficiency_level`, `evidence_certification_id`,
`evidence_verification_status`, `trade_category_code`, `risk_level`.

### 3.4 Direct workforce (tanpa vendor) — pool pekerja Handyman

`POST /handyman/provider-contexts` menerima **tepat satu** dari:

```json
{ "clientId": "<uuid>" }     // pool DIRECT: pekerja tetap/kontrak/freelance Handyman
{ "vendorId": "<uuid>" }     // pool VENDOR legacy: subkontraktor
```

* `clientId` → `providerType = 'DIRECT'`, `vendorId = null`. Tidak ada vendor yang dibuat.
* Maksimal **satu** pool DIRECT per Client (`409 HANDYMAN_PROVIDER_CONTEXT_ALREADY_EXISTS`).
* Pelaku harus punya akses nyata ke Client tersebut (`403 BUILDING_ACCESS_DENIED`).
* Endpoint baca yang tersedia hanya `GET /handyman/provider-contexts/by-vendor/{vendorId}`.
  **Belum ada** `by-client`; simpan `id` dari respons `201` (catat di gap matrix PART 04A).

Pekerja masuk ke pool lewat `POST /handyman/worker-contexts` (`handymanProviderContextId` +
`workforceProfileId`). Untuk pool DIRECT **tidak** diperlukan `vendor_workforce_bindings`.

Profil pekerja (dipakai layar "worker card"): `GET /handyman/field/workers/{workerContextId}/profile`
→ `workerIdentity` (`workforceType`, `employmentType`), `providerAssociation` (`providerType`,
`vendorId = null` untuk DIRECT), `skillsAndCategories.effectiveSkills`,
`certificationsAndExpiry.individualCertifications`.

### 3.5 Skill & sertifikat pekerja (data yang harus tampil di panel pemilihan)

| Endpoint | Permission |
| --- | --- |
| `POST /clients/{clientId}/skills`, `GET /clients/{clientId}/skills`, `GET /skills/{id}` | `skill.manage` / `skill.read` |
| `POST /workforce/{workforceId}/skills` | `skill.manage` |
| `GET /workforce/{workforceId}/skills`, `GET /workforce/{workforceId}/skills/effective` | `skill.read` |
| `PATCH /workforce/{workforceId}/skills/{skillId}` | `skill.manage` |
| `GET /workforce/{workforceId}/certifications` (filter `status`, `verificationStatus`, `skillId`, `currentOnly`) | `workforce_certification.read` |
| `POST /workforce/{workforceId}/certifications` | `workforce_certification.manage` |
| `GET /workforce/{workforceId}/certifications/{certificationId}` | `workforce_certification.read` |
| `PATCH /workforce/{workforceId}/certifications/{certificationId}` | `workforce_certification.manage` |
| `POST /workforce/{workforceId}/certifications/{certificationId}/verify` | `workforce_certification.verify` |
| `POST /workforce/{workforceId}/certifications/{certificationId}/deactivate` | `workforce_certification.manage` |
| `GET /workforce/{workforceId}/certifications/{certificationId}/decisions` | `workforce_certification.read` |

Catatan penting untuk UI:

* Sertifikat **tidak diverifikasi** (`verificationStatus = 'PENDING'`) tetap dihitung *belum memenuhi*
  requirement `MANDATORY` → `CERTIFICATION_UNVERIFIED`.
* Verifikasi diri sendiri ditolak (`WORKFORCE_CERTIFICATION_SELF_VERIFICATION_FORBIDDEN`).
* Sertifikat kedaluwarsa → `CERTIFICATION_EXPIRED`.
* Sertifikat milik trade lain **tidak boleh** dipakai untuk menyembunyikan pekerja dari daftar.

---

## 4. Ringkasan kontrak HTTP yang dipakai Operations

| Method | Path | Permission | Tujuan layar |
| --- | --- | --- | --- |
| GET | `/work-orders/{id}/classification` | `work_order.read` | status klasifikasi |
| PATCH | `/work-orders/{id}/classification` | `work_order.manage` | klasifikasi trade + risk |
| GET | `/work-order-trade-categories` | `work_order.read` | dropdown trade |
| POST | `/work-order-trade-categories` | `work_order.manage` | master trade |
| PATCH | `/work-order-trade-categories/{id}` | `work_order.manage` | ubah trade |
| POST | `/work-order-trade-categories/{id}/deactivate` | `work_order.manage` | nonaktifkan trade |
| GET | `/work-order-trade-categories/{id}/competency-requirements` | `work_order.read` | requirement trade |
| POST | `/work-order-trade-categories/{id}/competency-requirements` | `work_order.manage` | tambah requirement |
| PATCH | `/work-order-trade-categories/{id}/competency-requirements/{reqId}` | `work_order.manage` | ubah requirement |
| POST | `/work-order-trade-categories/{id}/competency-requirements/{reqId}/deactivate` | `work_order.manage` | nonaktifkan |
| POST | `/work-orders/{id}/assignments` | `work_order.manage` | assign pekerja |
| PATCH | `/work-orders/{id}/assignments/{assignmentId}` | `work_order.manage` | reassign / deactivate |
| GET | `/work-orders/{id}/assignments/current` | `work_order.read` | pekerja aktif |
| GET | `/work-orders/{id}/assignments` | `work_order.read` | riwayat |
| GET | `/work-orders/{id}/assignments/competency-decisions` | `work_order.read` | ledger audit |
| POST | `/handyman/provider-contexts` | `tenant_company.manage` | pool DIRECT/VENDOR |
| POST | `/handyman/worker-contexts` | `tenant_company.manage` | daftarkan pekerja ke pool |
| GET | `/handyman/field/workers/{workerContextId}/profile` | `tenant_company.read` | worker card |
| GET | `/organizations/{organizationId}/workforce-profiles` | `workforce.read` | daftar pekerja |
| GET | `/departments/{departmentId}/workforce-profiles` | `workforce.read` | daftar pekerja per departemen |
| GET | `/teams/{teamId}/workforce-profiles` | `workforce.read` | daftar pekerja per tim |
| GET | `/workforce/{id}/skills/effective` | `skill.read` | skill efektif |
| GET | `/workforce/{id}/certifications` | `workforce_certification.read` | sertifikat |

Semua endpoint di atas: `Authorization: Bearer <token>`, `401` bila tanpa sesi, `403` bila di luar
Client/Building scope, `/api/v1` prefix.

---

## 5. Anti-pattern yang harus dihindari di UI

1. Menyimpan status klasifikasi/kompetensi di state lokal lalu memakainya untuk mengaktifkan tombol
   assign — server tetap memutuskan; tombol hanya cermin dari `classificationRequired`/`satisfied`.
2. Menyaring pekerja dengan `workforceType === 'EXTERNAL'` (sisa mental model vendor). Semua tipe
   pekerja Handyman sah ditugaskan langsung.
3. Membuat vendor fiktif agar pekerja bisa ditugaskan.
4. Menampilkan `MANDATORY` dari satu trade sebagai syarat untuk semua trade.
5. Menutup dialog assignment saat `409` tanpa menampilkan `error.details[]`.
