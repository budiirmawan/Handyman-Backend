# W03 PART 00 — Quotation & Tenant PIC Approval Authority Reconciliation

**Status: REVIEW ONLY.** Dokumen ini tidak mengubah source, migration, permission, test, route, atau business logic. Tidak ada satu pun file produksi yang disunting pada PART ini.

- Repository: `budiirmawan/Handyman-Backend` · Branch: `arena/44e8ce22-handyman-backend` · HEAD: `eb9024c` · ancestry: `main`@`9602991` → 21 ahead / 0 behind, fast-forward, working tree bersih.
- Authority yang dihormati: `docs/e2e/HANDYMAN_BUSINESS_JOURNEY_v1.3_FROZEN.md` (frozen), `docs/handyman/CR-HM-06_DECISION_FREEZE.md` F1–F12 (frozen), `docs/handyman/CR-HM-00_CROSS_REPO_OWNERSHIP_MATRIX.md` (row 8 Quotation, row 9 Customer Quotation Approval, row 1 BM handoff = A — BACKEND CONTRACT BLOCKER).
- Metode: pembacaan seluruh permukaan quotation (`src/modules/handyman-quotations*/`, 20 file, 3239 baris), migration `0391`–`0395`, guard `handyman-quotation-access.ts`, `context-access.service.ts`, C6 wall di `handyman-service-request.repository.ts`, kontrak audit + notifikasi, OpenAPI, 6 file test quotation (54 test), dan silang dengan register W02 (G07, G08, D2, R-P5-1, §8.5 B-3).
- Test tidak dijalankan di PART ini (tidak diperlukan untuk review). Tidak ada Docker/Postgres yang dijalankan.

---

## 1. Authority matrix — seluruh aksi quotation yang ada hari ini

13 operasi publik / 7 path, semuanya di `src/modules/handyman-quotations-api/handyman-quotations-api.routes.ts`. Tidak ada endpoint quotation Handyman di luar ini (care-workspace: 0 referensi `quotation`).

| # | Aksi | Route | Gate route | Guard service | Identitas yang dicatat | Authority efektif | Gap |
|---|---|---|---|---|---|---|---|
| A1 | Buat thread quotation | `POST /handyman/requests/:id/quotation` | `tenant_company.manage` | `assertBuildingScopedResourceAccess` + diagnosis quotable + 1 thread/request (`handyman-quotation.service.ts:100-140`) | `created_by_user_id` = actor | Staf dengan `manage` di Building | Bukan aksi customer; sudah benar |
| A2 | Read thread + versi | `GET /handyman/requests/:id/quotation` | `tenant_company.read` | guard Building yang sama (`:236`) | — | Staf dengan `read` di Building | **Tenant PIC tidak punya jalur baca sendiri** (butuh assignment Building + permission staf) |
| A3 | Read versi presented | `GET /handyman/requests/:id/quotation/presented` | `tenant_company.read` | `getCurrentHandymanIssuedQuotationVersion` (`lifecycle:266-290`) | — | sama | Lihat T-06: read tidak memfilter `validUntil` |
| A4 | Revisi (versi baru) | `POST /handyman/quotations/:id/versions` | `manage` | guard + nomor monotonic (`:188-198`) | `created_by_user_id` | sama | Penyusun tidak didefinisikan journey (OD-6 terbuka, `journey:90`) |
| A5 | Tambah line | `POST /handyman/quotation-versions/:vid/lines` | `manage` | `version.status !== 'DRAFT'` ditolak (`line.service:153`) + DB trigger 0392 | `created_by_user_id` per baris | sama | **harga sepenuhnya deklarasi author**: `finalQuotedUnitAmount` dari body, `reference_unit_amount` opsional; tidak ada lookup price governed (F5 CR-HM-12: governed price = input, bukan otoritas CR-HM-06) |
| A6 | Read lines | `GET .../lines` | `read` | guard | — | sama | — |
| A7 | Read totals | `GET .../totals` | `read` | guard | — | sama | — |
| A8 | Issue (= present) | `POST .../issue` | `manage` | DRAFT only, ≥1 line, `validUntil > now(server)`, supersede atomik ISSUED lama (`lifecycle:104-158`) | actor | sama | Tidak ada event "kepada siapa" — `HANDYMAN_QUOTATION_ISSUED` tercatat tanpa recipient |
| A9 | Expire | `POST .../expire` | `manage` | hanya jika `now >= validUntil` (`:177-215`) | actor | sama | **Tidak ada scheduler**; `expireHandymanQuotationVersion` hanya dipanggil test/route (grep: 3 file, semuanya surface manual) → T-06 |
| A10 | Supersede | `POST .../supersede` | `manage` | ISSUED only (`:220-260`) | actor | sama | APPROVED/REJECTED tidak pernah bisa di-supersede (benar, terbukti test lifecycle 8) |
| A11 | **Decision (APPROVE/REJECT)** | `POST .../decision` | `tenant_company.manage` | lock version → guard Building → 1 keputusan per versi → `status==='ISSUED'` && `validUntil > now` → context customer dari lineage → insert + proyeksi + scope (APPROVE saja) + journal, satu transaksi (`decision.service.ts:150-311`) | `decided_by_user_id` = actor; **`tenant_pic_id` = `request.tenantPicId`** (null pada jalur CC) | **Staf mana pun dengan `manage` + assignment Building yang sama** | **INI JANTUNG W03.** Bukan PIC. Tidak ada maker-checker. Lihat T-01..T-04 |
| A12 | Read decision | `GET .../decision` | `read` | guard (404 bila tanpa thread) | — | sama | — |
| A13 | Read execution scope | `GET .../execution-scope` | `read` | guard | — | sama | — |

**Kesimpulan authority (item 4 scope):** satu permission administratif umum, `tenant_company.manage`, adalah kunci untuk SEMUA aksi komersial termasuk menyetujui quotation atas nama tenant. `tenant_company.manage` dipakai di 23 titik mount di 12 file (grep `requirePermission('tenant_company.manage')`) — termasuk CRUD tenant company, BAST, provider, readiness, warranty, scope-assignment, lifecycle triage-inspection-diagnosis-referral, dan `tenant-approvals`. Tidak ada satu pun permission khusus quotation di katalog: grep `quotation` di `src/database/seeds/foundation-access.seed.ts` = **0 hasil**. Overgrant terkonfirmasi sebagai desain, bukan bug.

---

## 2. Model identitas: enam peran harus terpisah (item 6)

| Peran | Tempat tinggal saat ini | Otoritas | Status W03 |
|---|---|---|---|
| Reporter (yang melapor) | `handyman_service_request_contacts.reporter_*` (0435, append-only) + `captured_by_care_actor_id` | Tidak ada — data snapshot saja | Selesai di W02; jangan pernah dijadikan approver |
| Contact person (koordinasi) | kolom `contact_person_*` tabel yang sama | Tidak ada | Selesai di W02; **bukan** penerima keputusan |
| Beneficiary (penerima layanan) | `handyman_service_requests.tenant_company_id` (dari attribution) | Tidak ada otoritas login | Tetap demikian |
| Customer Care (pencatat & pembuat request) | Care actor attested (`handyman_handoff_care_actors`) + sesi workspace | Buat request, baca readback C6; **tidak** punya route quotation | Tidak boleh menyusun/menyetujui quotation (T-05) |
| Operations (pen triase & eksekusi) | `handyman.operations.request.read` / `.triage` + assignment Building aktif | Baca queue, triage; **tidak** seharusnya memutuskan harga | Jangan diberi approval authority |
| **PIC Approver** | `tenant_pics` (0145: `user_id` NULLABLE, `status`, `is_primary`, satu primary per tenant) | **Tidak ada jalur khusus PIC.** Hari ini "approval customer" diwakili User staf (A11) | Ini yang dibangun W03 |

Fakta pembatas yang harus diterima sebelum desain:
- `handyman_quotation_decisions.decided_by_user_id UUID NOT NULL REFERENCES users (id)` (0394) → **tanpa `users` row, tidak ada keputusan yang bisa ditulis**. `tenant_pic_id` nullable.
- `tenant_pics.user_id` nullable dan indeksnya partial (`WHERE user_id IS NOT NULL`) → PIC tanpa tautan User tidak bisa jadi penanda tangan.
- Handoff BM secara eksplisit **tidak** mengarang `users`: `handoff-runtime.service.ts:44` "tenant-pics.userId is never fabricated". Jadi identitas PIC dari klaim BM ≠ User lokal.
- Journey v1.3 `:23` menyatakan Tenant/PIC "**Tidak login langsung**". Konsekuensinya: W03 tidak boleh menyelesaikan gap ini dengan menyuruh PIC membuat akun + password lokal; jalurnya harus sesi terbatas yang di-attestasi (pola yang sama dengan `admitCareWorkspace` + assertion, `rfqVendorSessionMiddleware`, dan arrival challenge 0397).
- CR-HM-06 F6 (frozen) hari ini: "Actor = authenticated local user with required Client/RBAC authority; caller-supplied customer identity is never authority". Mengubah definisi actor = **amandemen F6**, bukan perubahan diam-diam (Q-D1).

---

## 3. Desain approver otoritatif (item 5)

Predikat yang direkomendasikan — **semuanya reuse, nol otoritas paralel**:

```
PIC_DECIDE_ELIGIBLE(actorUser, quotationVersion) ⇔
  1. versi adalah ISSUED exact + server-time validUntil > now   [sudah ada: decision.service.ts:196-203]
  2. request induk TERBACA oleh actorUser di bawah dinding C6 yang ada
        getHandymanServiceRequestDetail(requestId, actorUser) ≠ null
        → customerRequestReadScope (handyman-service-request.repository.ts:184-232):
          PIC ACTIVE pada tenant company yang sama + tenant_building_contexts
          ACTIVE dalam jendela efektif + tenant_space_relationships + rantai space
  3. actorUser terurai ke PIC ACTIVE tenant yang sama
        tenant_pics.user_id = actorUser AND status='ACTIVE'
        AND pic.tenant_company_id = request.tenant_company_id
        [idiom yang sama dipakai handoff: attribution.service.ts:242-252,
         dan tenant-communication.service.ts:90-121 assertRecipient]
  4. maker-checker identitas: actorUser ≠ version.created_by_user_id
        DAN actorUser ≠ quotation.created_by_user_id
        DAN actorUser ∉ {line.created_by_user_id versi ini}     [BARU — lihat T-02]
  5. tulis ke LEDGER YANG SAMA: handyman_quotation_decisions
        (tenant_pic_id = pic.id, decided_by_user_id = actorUser)
        + proyeksi ISSUED→APPROVED|REJECTED + scope atomik (F8)
```

Yang secara sadar **tidak** dilakukan: tidak membuat tabel approval kedua, tidak memakai `tenant-approvals` (BE-14H, mesin approval binding entitas lain; bila dipakai di sini akan ada dua ledger untuk satu fakta — pelanggaran "no duplicate authority"), tidak memperluas `assertQuotationThreadBuildingAccess` agar menerima PIC (guard itu didefinisikan sebagai assignment eksplisit — `context-access.service.ts:96-124`; menyisipkan occupancy ke dalamnya akan mengubah semantics 12 file), tidak menambah grant default untuk siapa pun.

Konsekuensi desain yang harus dipilih (Q-D2): jalur staf dengan `manage` (A11 hari ini) tetap boleh mencatat keputusan? Opsi: (a) tetap boleh tetapi **harus** tercatat sebagai fakta berbeda (mis. kolom discriminator aditif `decision_authority TEXT CHECK IN ('TENANT_PIC','STAFF_ON_BEHALF')` di 0394-tabel-immutable — ALTER additive, trigger row-level 0394 tidak menghalangi ADD CONSTRAINT/ADD COLUMN), dan setiap downstream (execution scope, syarat penjadwalan) hanya mengakui `TENANT_PIC`; (b) hentikan total jalur staf (breaking, mengubah CR-HM-06 certified behavior, butuh amandemen F6 + migration backfill `tenant_pic_id` — dan tidak bisa di-backfill untuk request CC yang `tenant_pic_id`-nya null). **Rekomendasi: (a)**, karena menjaga ledger append-only, tidak menghapus hak yang sudah ada secara diam-diam, dan membuat syarat journey "persetujuan Tenant = prasyarat penjadwalan" benar-benar bisa ditegakkan.

Koreksi fakta penting terhadap syarat journey: hari ini **syarat itu tidak ditegakkan di mana pun**. `handyman_execution_scopes` (0395) hanya menyimpan `tenant_pic_id` nullable dan `status CHECK IN ('AUTHORIZED')`; grep tidak menemukan satu pun downstream yang membedakan keputusan yang customer-authoritative vs staf. Jadi "quotation disetujui Tenant/PIC" saat ini terpenuhi secara formal oleh keputusan User staf mana pun — termasuk author yang menyetujui quotation buatannya sendiri.

---

> **KOREKSI dari W03 PART 01 (F-05).** Langkah 2 di atas ("request induk terbaca di bawah dinding C6")
> **tidak memadai**: seluruh predikat `customerRequestReadScope` — termasuk cabang PIC — bersarang di dalam
> `EXISTS (user_building_assignments … status=ACTIVE)`, sehingga PIC murni tanpa assignment Building tetap
> tertutup. Yang boleh di-reuse hanyalah komponen occupancy-nya, sebagai bagian dari predikat customer baru
> yang tidak menuntut assignment. Lihat `W03_PART01_PIC_READINESS_AND_REGISTRY_GUARD.md` §2.2.

## 4. Lifecycle: quotation → present → keputusan PIC terautentikasi (deliverable diagram)

```
 status request (W02)                    domain quotation (CR-HM-06, FROZEN)                W03 target
────────────────────────────────────────────────────────────────────────────────────────────────────────────
 prasyarat A1 = BUKAN status tertentu,   POST /requests/:id/quotation
 melainkan "ada diagnosis dengan            (manage + exact-Building + diagnosis scope-class quotable)
 scope class quotable" + assignment          │  creates root + v1 DRAFT (immutable id)
 Building aktif (quotation.service:108-119; allowlist scope class di :54)
                                             ▼
                                    ┌──────────────────┐  POST .../lines (manage)
                                    │  DRAFT  v_n      │◄───────────┐  hanya selama DRAFT
                                    └────────┬─────────┘            │  (status!=='DRAFT' → 400;
                                             │ POST .../issue       │   DB trigger 0392 memblokir
                                             │ validUntil > now     │   UPDATE/DELETE)
                                             ▼                      │
                              ┌───────────────────────────┐        │
        (presentasi = ISSUED) │        ISSUED  v_n        │◄───────┘  0393: maksimum satu ISSUED
                              │  validUntil, lines frozen │            per thread (partial unique)
                              └───┬───────────┬───────┬───┘
             now ≥ validUntil     │           │       │   POST .../supersede (manage, ISSUED only)
        ┌─────────────────────────┘           │       └──────────────┐
        ▼                                     ▼                      ▼
   EXPIRED                        ═══ KEPUTUSAN CUSTOMER ══     SUPERSEDED
                                  (diposting ke PIC melalui
                                   jalur terautentikasi)        (APPROVED/REJECTED/EXPIRED
        │                                     │                 tidak bisa di-supersede —
        │  A11 hari ini: manage+Building       │                 lifecycle test 8)
        ▼                                     ▼
   ┌──────────────────────────────────────────────────────────────┐
   │ POST .../decision  {decision: APPROVE|REJECT}                │
   │   header Idempotency-Key (controller:42-43, :278)            │
   │   SATU transaksi: lockVersion → [W02: +PIC eligibility +    │
   │   maker-checker] → insert immutable decision →               │
   │   ISSUED→APPROVED|REJECTED → (APPROVE) Execution Scope       │
   │   + journal HANDYMAN_QUOTATION_APPROVED|_REJECTED            │
   └──────────────────────────────────────────────────────────────┘
                       │ UNIQUE(version) → replay sama = 200 fakta asli
                       │ UNIQUE(idempotency_key) global → konflik = 409
                       ▼
              APPROVED ──► Execution Scope (AUTHORIZED, 1 per versi) ──► CR-HM-04/05/07/08
              REJECTED ──► tidak ada scope (F8) — jalur revisi = VERSI BARU, bukan mutasi
```

Review delapan aspek (item 8):

| Aspek | Temuan | Verdict |
|---|---|---|
| Versioning | `version_number` monotonic per thread; `UNIQUE(quotation_id, version_number)` (0391); revisi = versi baru DRAFT, tanpa menyalin lines | **EXCELLENT** — jangan disentuh |
| Immutability setelah present | lines + version identity dilindungi trigger DB (0391 `..._version_block_mutation` mengizinkan hanya kolom lifecycle proyeksi; 0392 `..._line_no_write`), plus guard app-level `status!=='DRAFT'` | **CLOSED** — terbukti di DB backstop (line test 8) |
| Expiry | `expire` hanya sah saat `now ≥ validUntil`; **tidak ada scheduler**; `findCurrentIssued` TIDAK menyaring `valid_until` (`repository:176-188`) → versi kedaluwarsa masih muncul sebagai "presented" sementara decision menolaknya | **PARTIAL (T-06)** |
| Idempotency | `Idempotency-Key` header + fingerprint sha256([versionId, decision]); replay identik → fakta asli; beda → 409. Decision: **UNIQUE(idempotency_key) global lintas client/tenant** | **PARTIAL (T-05)** |
| Concurrency | `lockVersionById` (FOR UPDATE) + `lockDecisionByVersion` + `23505→409`; double-approve menghasilkan tepat 1 decision + 1 scope (decision test 9, api test 6) | **CLOSED** |
| Audit | journal `HANDYMAN_QUOTATION_ISSUED/SUPERSEDED/EXPIRED` masuk kontrak audit (`handyman-audit-contract.ts:102-116`); **`HANDYMAN_QUOTATION_APPROVED`/`_REJECTED` TIDAK ada di kontrak audit maupun kontrak notifikasi** (grep: hanya literal di `decision.service.ts:296-297`) | **PARTIAL (Q-D5)** |
| Replay | replay mengembalikan keputusan asli + scope; tidak ada check bahwa pemanggil replay = pembuat keputusan asli | **PARTIAL (T-04)** |
| Notifikasi ke PIC | kontrak notifikasi mengenal ISSUED/SUPERSEDED/EXPIRED, tidak mengenal decision events; recipient policy tenant/PIC belum didefinisikan (kelanjutan R-P5-1) | **MISSING (Q-D6)** |

---

## 5. Capability matrix W03

| ID | Capability | Status | Bukti | Keputusan |
|---|---|---|---|---|
| Q01 | Quotation thread per request + versi immutable | **EXISTING** | 0391; `quotation.service.ts:100-140`; quotation test 10 | — |
| Q02 | Line komersial + totals + arithmetic CHECK | **EXISTING** | 0392 `line_total = ROUND(qty×final,2)`; line test 10 | — |
| Q03 | Issue/present + supersede atomik + expiry rules | **EXISTING** | `lifecycle.service.ts:104-260`; 0393; lifecycle test 10 | — |
| Q04 | Decision ledger atomic + replay + concurrency | **EXISTING** | `decision.service.ts:150-311`; decision test 7/8/9 | — |
| Q05 | Execution Scope dibuat hanya oleh APPROVE, 1 per versi | **EXISTING** | 0395 `UNIQUE(approved_quotation_version_id)`; F8; api test 6 | — |
| Q06 | Building-scope untuk seluruh jalur quotation | **EXISTING** | `quotation-access.ts:26-41` (trace ke request induk, no existence leak); scope-guard test 1–4 | — |
| Q07 | Keputusan diotorisasi oleh **Tenant PIC terautentikasi** | **MISSING** | A11: cukup `tenant_company.manage` + assignment; `tenant_pic_id` disalin dari request (null di jalur CC, decision test 6 mengunci "NULL PIC never fabricated") | **Q-D1, Q-D2** |
| Q08 | Jalur baca quotation untuk customer (presented → PIC) | **MISSING** | A2/A3 butuh `tenant_company.read` + assignment Building; 0 route quotation di care-workspace | Q-D3 |
| Q09 | Maker-checker: penyusun ≠ penyetujui | **MISSING** | 0 service memeriksa `created_by_user_id` vs `actorUserId`; precedent tersedia: payment `service.ts:390-393` ("recorder may never be its verifier", dicek sebelum replay) | **Q-D4** |
| Q10 | Discriminator otoritas keputusan di ledger (TENANT_PIC vs STAFF_ON_BEHALF) | **MISSING** | 0394 tidak punya kolom apa pun yang membedakan | Q-D2 |
| Q11 | Syarat journey "persetujuan Tenant sebelum penjadwalan" ditegakkan downstream | **MISSING** | scope 0395 tidak membedakan siapa yang menyetujui; grep: 0 consumer membaca `decision_authority` | Q-D2 |
| Q12 | Permission khusus quotation (pisah authoring vs decision) | **MISSING** | 0 kode `*quotation*` di katalog permission; satu `manage` untuk 13 operasi | Q-D7 |
| Q13 | Provisioning PIC → `users` link (data readiness) | **UNVERIFIED** | `tenant_pics.user_id` nullable + partial index; tidak ada helper `findActivePicByUser` (repository hanya findById/listByTenantCompany) | **Q-D8** |
| Q14 | Idempotency key scoping per versi/aktor | **PARTIAL** | UNIQUE global lintas client (0394 `..._key_unique`) | Q-D9 |
| Q15 | Auto-expiry (agar read & decision konsisten) | **PARTIAL** | route `expire` manual; substrate `due-job-dispatcher` ada (CR-BE-STAB-01, disebut di audit contract header) | Q-D10 |
| Q16 | Audit vocabulary menutupi APPROVED/REJECTED | **PARTIAL** | event direkam ke `operational_events` tetapi tidak terdaftar di kontrak audit/notifikasi | Q-D5 |
| Q17 | Notifikasi ke PIC saat presented / saat hasil keputusan | **MISSING** | tidak ada templateKey decision events; recipient policy tenant belum ada | Q-D6 |
| Q18 | Price governed (bukan deklarasi bebas) | **PARTIAL** | `reference_unit_amount` nullable, `source_item_id` hanya untuk MATERIAL; tidak ada lookup governed price (F5 CR-HM-12: harga governed = otoritas CR-HM-12, bukan CR-HM-06) | Q-D11 (di luar W03 default) |
| Q19 | Affordance readback "boleh memutuskan sekarang" untuk UI | **MISSING** | tidak ada `available-actions` untuk quotation (grep 0); `status-visibility` ada untuk request, tidak memuat kelayakan approval | Q-D3 |
| Q20 | OpenAPI permukaan quotation | **EXISTING** | 10 path terdaftar (`openapi.yaml:5529â:5799`), `Idempotency-Key` disebut 42× | verifikasi respons oleh frontend = Q-D12 |
| Q21 | Frontend: presentasi & penangkapan keputusan customer | **UNVERIFIED** | row 9 ownership matrix: frontend hanya present/capture; tidak ada di repo ini | repo frontend, jangan diklaim |
| Q22 | Cross-repo / BM customer handoff sebagai sumber identitas PIC | **UNVERIFIED + BLOCKER** | row 1 ownership matrix = "A — BACKEND CONTRACT BLOCKER"; `handoff-runtime.service.ts:44` tidak mengarang `users` | Q-D1 (jalur sesi terbatas) |

---

## 6. Security & approval threat matrix

| ID | Ancaman | Hari ini | Sev | Mitigasi yang diusulkan (tanpa menambah otoritas paralel) |
|---|---|---|---|---|
| T-01 | Self-approval penuh: satu pemegang `manage` di Building dapat membuat thread → isi lines → issue → **approve** | Terbuka. Tidak ada satu pun guard | **P0** | Predikat Q07 langkah 3 + maker-checker Q09; tolak dengan 403 `SELF_APPROVAL_FORBIDDEN` (kode error baru, additive) |
| T-02 | Approver = author versi / author thread / penulis lines | Tidak dicek sama sekali | **P0** | Bandingkan terhadap `version.created_by_user_id`, `quotation.created_by_user_id`, dan `line.created_by_user_id`; cek **sebelum** cabang replay (idiom payment `:390-393`) supaya replay tidak bisa dipakai mem-bypass |
| T-03 | Approver dari tenant lain / building lain dalam Client yang sama | Tertutup oleh Q06 + (bila W03 jadi) dinding C6 | — | Jangan pakai `canAccessClient` (client-wide) untuk jalur PIC; pakai `customerRequestReadScope` |
| T-04 | Replay oleh aktor lain: pemanggil kedua dengan key + payload identik mendapat 200 fakta asli (termasuk `executionScope`) meski bukan dia pembuatnya | Cabang replay tidak memverifikasi actor (`decision.service.ts:190-205`) | P1 | Tambahkan syarat `existing.decided_by_user_id === actor` (atau `=== actor PIC link`) sebelum mengembalikan replay; beda → 403, tanpa membocorkan keberadaan |
| T-05 | Tabrakan & oracle lintas tenant pada `Idempotency-Key` (UNIQUE global) | Pemakaian key yang sama oleh dua tenant → 409; perbedaan 409 vs replay membocorkan "key ini sudah dipakai" | P1 | Scoping key (Q-D9) + samarkan konflik menjadi status yang sama |
| T-06 | Expiry tidak seragam: read `presented` menampilkan versi yang sudah lewat `validUntil`, decision menolaknya; tidak ada auto-expire | Terbuka | P1 | Filter `valid_until > now()` pada `findCurrentIssued` **atau** dispatcher due-job; pilih salah satu dan catat (Q-D10) |
| T-07 | Customer Care atau Operations ikut memutuskan harga | CC: 0 route quotation (aman). Operations: permission queue/triage **tidak** memberi `manage` → tidak bisa A11 (aman) | — | Jangan pernah memberi `manage` ke persona CC/Operations; pertahankan sebagai invarian |
| T-08 | Ekspos data komersial lewat Operations Queue | **TERTUTUP.** Bentuk publik queue (`handyman-operations-queue.service.ts:22-50`) hanya: request, status, tenant (id/code/name/picId), location, service, attribution, contact. 0 field harga/amount/totals; 0 join ke tabel quotation | — | Tidak ada aksi. Tambahkan regression guard (assert kolom) di W03 agar tetap begitu |
| T-09 | Ekspos PII kontak pelapor ke pemegang read Building | Terbuka sebagai keputusan (W02 R-2 / B-1): queue menampilkan `contact` ke operator ber-assignment | P1 (keputusan) | Tetap gerbang W02; jangan dilebarkan ke permukaan baru |
| T-10 | Dua ledger approval (quotation decision vs `tenant-approvals` BE-14H) | `tenant-approvals` adalah mesin binding approval entitas lain, juga bermigrasi ke `manage`; belum menyentuh quotation | P2 (arsitektur) | Tegaskan: decision quotation hanya `handyman_quotation_decisions`; `tenant-approvals` tidak dipakai untuk quotation |
| T-11 | Harga & kondisi diubah setelah disetujui | Tertutup (trigger 0391/0392 + guard DRAFT + 1 keputusan per versi) | — | Tidak ada aksi |
| T-12 | Side effect melampaui boundary (payment/BAST/FM/crew) | Tertutup: decision hanya membuat scope; decision test 10 mengassert 0 side effect (F10/F11) | — | Jangan melebarkan saat menambah PIC path |

---

## 7. Review ROUTE-TO-REGISTRY terhadap `requireAnyPermission` (item 10)

- Gerbang scanner: `tests/config-perm-01-permission-registry.test.ts:177` → `PERMISSION_CALL = /requirePermission\(\s*['"`]([^'"`]+)['"`]\s*\)/g`, dijalankan atas file `*.routes.ts` di `src/modules` + `src/routes`.
- Konsekuensi konkret: pola `const x = requireAnyPermission(['a','b'])` (satu-satunya pemakaian: `handyman-lifecycle-api.routes.ts:50-53`, helper di `rbac.middleware.ts:55`) **tidak terlihat** oleh gerbang. Kode yang hanya dipasang lewat any-of tidak akan pernah diwajibkan terdaftar di `FOUNDATION_PERMISSIONS` — dan juga lolos dari pemeriksaan "kode di mount harus ada di registry".
- Status hari ini: tidak ada pelanggaran aktif. Kedua kode pada any-of (`tenant_company.read`, `handyman.operations.request.read`) memang terdaftar (seed `:257` dan katalog). Temuan ini adalah blind spot, bukan celah otorisasi.
- Relevansi W03: bila W03 memasang decision route sebagai "PIC-link ATAU permission staf" dengan `requireAnyPermission`, **route itu berada di luar jangkauan gerbang registry** — persis tipe perubahan otoritas yang harus paling dijaga. Karena itu gerbang harus diperbaiki **sebelum** part yang menambahkan any-of kedua.
- Perbaikan yang diusulkan (test-only, nanti di PART terpisah, bukan sekarang): perluas pemindaian ke `requireAnyPermission([...])` (parse array literal) dan assert setiap kode hasil parse ∈ katalog + ∈ `UNASSIGNED_BY_DEFAULT_PERMISSION_CODES` bila ia permission khusus; pertahankan semantics default-deny. Jangan mengubah runtime gate sebagai "perbaikan" — gate adalah business logic (review-only).
- Catatan sekunder: `config-perm-01` hanya memindai file bernama `*.routes.ts`; helper guard di file non-route (mis. `context-access.service.ts`) tidak — itu memang by design, tetapi layak disebut di register.

---

## 8. Keputusan desain yang perlu disetujui (DELIVERABLE)

| ID | Keputusan | Opsi | Rekomendasi | Bila tidak diputuskan |
|---|---|---|---|---|
| Q-D1 | Bentuk "Tenant PIC terautentikasi" padahal v1.3 `:23` berkata PIC tidak login langsung dan F6 mengunci actor = local user | (a) User lokal + link `tenant_pics.user_id`; (b) sesi terbatas ber-attestasi (pola care-workspace / `rfqVendorSessionMiddleware` / arrival challenge); (c) surat keputusan amandemen F6 + journey | **(b) untuk eksekusi, dengan (c) sebagai prasyarat dokumen**: keputusan ditulis sebagai `decision_authority='TENANT_PIC'` atas nama PIC yang di-attestasi, ditopang link `users` bila ada; **tanpa** menciptakan login password baru. Ini juga menjawab row 1 ownership matrix yang masih berstatus BACKEND CONTRACT BLOCKER | Q07/Q08/Q22 tetap MISSING; W03 tidak bisa mulai coding decision |
| Q-D2 | Nasib jalur staf (`manage`) untuk A11 | (a) discriminator `decision_authority` + downstream hanya akui `TENANT_PIC`; (b) hapus jalur staf | **(a)**. Ledger tetap append-only, tidak memutus caller existing secara diam-diam, dan syarat "persetujuan Tenant sebelum penjadwalan" (journey `:40`) akhirnya bisa ditegakkan (Q11) | Jalur staf terus menjadi approval "customer" palsu |
| Q-D3 | Kontrak baca untuk customer (presented + affordance) | (a) perluas read C6 ke quotation via jalur baca request saja; (b) route baru khusus PIC-session; (c) tidak ada (UI BM yang ambil) | **(a) dulu** (reuse `getHandymanServiceRequestDetail` sebagai gerbang), (b) hanya bila Q-D1 memilih sesi terbatas. Tambahkan affordance server-derived (Q19), bukan aturan di UI | PIC tidak pernah melihat apa yang harus disetujui |
| Q-D4 | Cakupan maker-checker | (a) hanya vs author versi; (b) vs author versi + author thread + penulis lines; (c) vs semua staf di Client | **(b)**, dicek sebelum replay (idiom payment `:390-393`) | T-01/T-02 tetap P0 |
| Q-D5 | Daftar `HANDYMAN_QUOTATION_APPROVED/REJECTED` ke kontrak audit (+ notifikasi?) | (a) daftarkan di audit contract saja; (b) audit + notifikasi; (c) biarkan (event tak berveocabulary) | **(a)** wajib (vocabulary = governed list; event hari ini direkam di luar daftar); (b) ditunda sampai Q-D6 | Drift vocabulary: fakta audit direkam di luar governed list |
| Q-D6 | Pemberitahuan ke PIC (presented, hasil keputusan) | (a) `tenant-communications` (sudah punya `assertRecipient` + resolusi PIC→User, `tenant-communication.service.ts:90-121`); (b) handyman notification outbox + policy recipient; (c) tanpa notifikasi (PIC polling) | **(a)** untuk W03 (tidak menyentuh seam BE-26C dan tidak menyentuh R-P5-1 yang belum diputuskan), (b) nanti saat policy recipient/channel didefinisikan | PIC tidak tahu ada yang menunggu; approval SLA mati |
| Q-D7 | Pisah permission authoring vs decision | (a) tetap `tenant_company.manage`; (b) `handyman.quotation.author` + `handyman.quotation.decision`, dua-duanya `UNASSIGNED_BY_DEFAULT_PERMISSION_CODES`, migration additive (`ON CONFLICT DO NOTHING`, 0 grant); (c) permission saja untuk decision | **(b)**, pola persis seperti W02 PART 02A/04A dan payment PART 02B (registry + no-auto-grant + test no-grant). Bila (a): overgrant T-01 tidak terangkat level root | `manage` tetap = tombol approve |
| Q-D8 | Kesiapan data PIC | (a) ukur dulu; (b) asumsikan cukup | **(a)**: SELECT jumlah `tenant_pics` ACTIVE dengan/without `users` link per tenant, di staging/prod. Tidak ada test yang bisa menggantikan angka ini. Bila mayoritas tanpa link → W03 butuh program tautan identitas sebelum gate Q-D2(b) efektif | Rencana coding dibangun di atas asumsi kosong (UNVERIFIED Q13) |
| Q-D9 | Scoping `Idempotency-Key` keputusan | (a) biarkan global; (b) composite `(quotation_version_id, idempotency_key)` aditif + retire yang lama | **(b)**; tabel decision dilindungi trigger row-level sehingga `ALTER TABLE ... ADD CONSTRAINT` tetap aman; dokumen must record key lama tetap unik sampai decision berikutnya | T-05 |
| Q-D10 | Mekanisme expiry | (a) filter `valid_until > now()` di `findCurrentIssued`; (b) due-job auto-expire; (c) dua-duanya | **(a) wajib** (read tidak boleh menawarkan yang tak bisa diputuskan); (b) opsional, pakai `due-job-dispatcher` yang sudah jadi substrate | T-06 |
| Q-D11 | Governed price (F5 CR-HM-12) | (a) tetap deklarasi + snapshot; (b) wajib `reference_unit_amount` dari governed price | **(a) untuk W03** — harga governed adalah otoritas CR-HM-12; jangan mencuri domain itu. Catat Q18 sebagai PARTIAL permanen | Scope creep komersial |
| Q-D12 | Verifikasi kontrak oleh frontend | — | Bukan W03 backend: kirim kontrak + minta bukti dari repo frontend (AC-12 gaya W02) | Klaim E2E tak berdasar |

---

## 9. Rekomendasi urutan coding W03 (PART kecil, tanpa menyentuh frozen journey)

Prinsip: satu PART = satu keputusan yang sudah disetujui; authority hanya boleh bergeser ke arah lebih sempit; tidak ada permission baru dengan grant default; tidak ada rute paralel untuk fakta yang sama.

> **STATUS RANTAI (diperbarui 2026-10-10).** Tabel di bawah adalah rekomendasi PART 00 dan **dipertahankan apa adanya untuk audit**; dia bukan lagi urutan kerja.
> - `W03-01` sudah dieksekusi sebagai **W03 PART 01** (gerbang registry + readiness PIC; `21a7b47`).
> - `W03-03` sudah dieksekusi sebagai **W03 PART 02** → amandemen formal **`CR-HM-06/A01`** (`docs/handyman/CR-HM-06_AMENDMENT_01_TENANT_PIC_APPROVAL_ACTOR.md`), **PROPOSED**.
> - Urutan normative saat ini = **amendment §13 (03A–03G)**; blocker = `docs/e2e/W03_PART02_PIC_APPROVAL_CONTRACT_FREEZE.md` §6.
> - **03A sudah dieksekusi** (2026-10-10): F6 diratifikasi pada **v1.1** + `CR-HM-06_ADDENDUM_A_TENANT_PIC_BINDING_AUTHORITY.md` (late PIC binding, menjawab F-06). Urutan kini **03B → 03B2 → 03C → (03D ∥ 03E) → 03F → 03G → 03H**; lihat `docs/e2e/W03_PART03A_LATE_PIC_BINDING_RATIFICATION.md` §6. Baris BLK-1/BLK-5 di PART 02 §6 **digantikan** di sana.
> - `W03-05` tidak berlaku sebagaimana ditulis: langkah "§3 langkah 2–3" (reuse C6 sebagai otoritas approver) **batal oleh F-05**, dan maker-checker-nya (`W03-02`) diserap ke MC1/MC2 + perbaikan replay-actor (C2) di amendment §8/§10.
> - `W03-04` (permission `decide`) **tidak jadi** untuk jalur PIC: A2 membuat PIC non-RBAC by construction; permission hanya relevan bila arsitektur kelak menuntut baca staff yang lebih sempit.

| PART | Isi | Prasyarat | Ukuran | Batas keras |
|---|---|---|---|---|
| **W03-01** | Ukur & dokumentasi: readiness link PIC (Q-D8), matriks `manage`-holders di produksi, dan 0 perubahan kode. Perbaiki gerbang registry (§7, test-only) | — | dokumen + 1 test patch | Jangan menyentuh runtime gate |
| **W03-02** | Maker-checker + replay-actor check di `decideHandymanQuotation` (Q-D4, T-01/T-02/T-04) — service-level, tanpa permission baru | W03-01 | kecil (1 service + test) | Tidak mengubah F6/F7 semantics selain menolak self-approval; cek sebelum replay |
| **W03-03** | Permintaan amandemen F6 + keputusan PIC-session (Q-D1): dokumen, kontrak OpenAPI draf, tanpa kode | W03-01 | dokumen | Jangan coding sebelum disetujui; journey v1.3 tidak diedit |
| **W03-04** | Split permission author/decision (Q-D7) + registry + migration `0437` additive + no-auto-grant test | W03-01 | kecil-menengah | Fallback `manage` harus diputuskan eksplisit (jangan diam-diam, pelajaran R-P4A-1) |
| **W03-05** | `decision_authority` + eligibility predicate PIC (Q-D2 + §3 langkah 2–3), reuse `getHandymanServiceRequestDetail` | W03-02, W03-04 | menengah | Jangan melebarkan `context-access`; jangan menambah tabel ledger |
| **W03-06** | Readback customer: presented-read untuk jalur PIC + affordance (Q-D3, Q19) | W03-05 | kecil | Read-only; jangan menyentuh C6 wall semantics |
| **W03-07** | Expiry consistency (Q-D10(a)) + notifikasi via `tenant-communications` (Q-D6) + audit vocabulary (Q-D5) | W03-05 | kecil, 3 fokus terpisah | Jangan menyentuh seam BE-26C; jangan klaim delivery |
| **W03-08** | Idempotency key scoping (Q-D9) + guard regresi T-08 (assert kolom queue) | W03-02 | kecil | Migrasi additive di tabel immutable: hanya ADD CONSTRAINT, tanpa rewrite |
| **W03-FE** | Verifikasi kontrak di repo frontend (Q-D12) | W03-06 | — | Tidak ada klaim E2E tanpa bukti dua sisi |

Urutan eksekusi: 01 → 02 → (03 sebagai gerbang dokumen) → 04 → 05 → 06 → 07 → 08 → FE. PART 02 sengaja didahulukan dari permission split karena ia menutup P0 (self-approval) tanpa menunggu keputusan sesi.

### 9.1 Acceptance criteria closure W03

| AC | Kriteria | Bukti yang diminta |
|---|---|---|
| W03-AC-01 | Author versi tidak bisa menyetujui versinya (LABOR+MATERIAL, staf & PIC) | test runtime positif + negatif, cek sebelum replay |
| W03-AC-02 | Keputusan hanya sah oleh PIC ACTIVE yang terlink ke User dan lolos dinding C6 pada request induk | test: PIC benar → 200; PIC tenant lain → 403/404 tanpa kebocoran; PIC tanpa link → ditolak dengan alasan jelas |
| W03-AC-03 | `manage` saja tidak lagi cukup untuk memutuskan (bila Q-D7 (b) disetujui) | test negatif `manage`-only; registry + no-auto-grant |
| W03-AC-04 | Satu keputusan per versi; replay idempotent; concurrency aman | tetap hijau (regresi decision test 7/8/9) |
| W03-AC-05 | Downstream (Execution Scope) hanya mengakui keputusan `TENANT_PIC` untuk syarat penjadwalan | test: scope dibuat oleh PIC-decision; staff-on-behalf tidak memenuhi syarat |
| W03-AC-06 | Tidak ada ekspos komersial di Operations Queue | guard test kolom (T-08) |
| W03-AC-07 | Tidak ada perubahan C6, tidak ada otoritas paralel, tidak ada schema weakening | `git diff` pada `customerRequestReadScope` + review queue |
| W03-AC-08 | Read `presented` tidak menawarkan versi kedaluwarsa | test T-06 |
| W03-AC-09 | Audit vocabulary memuat APPROVED/REJECTED | test kontrak audit (part03) + delta katalog |
| W03-AC-10 | Frontend + cross-repo TIDAK diklaim | register eksplisit |

---

## 10. Yang secara sadar TIDAK diverifikasi di PART ini

- Tidak ada test yang dijalankan (54 test quotation yang ada di `tests/handyman-quotation*.test.ts` tidak dieksekusi di sesi ini; statusnya adalah hasil run W01/CR-HM-06, dan tree modul quotation 0-diff sejak saat itu — diverifikasi lewat `git log --oneline` pada path tersebut bila diperlukan saat coding).
- Tidak ada runtime HTTP, tidak ada DB, tidak ada scheduler.
- Tidak ada angka `tenant_pics.user_id` (Q-D8) — UNVERIFIED sampai ada query di staging/prod.
- Tidak ada klaim apa pun tentang frontend, BM Super App, atau journey dua arah.
- Detail governed pricing (CR-HM-12) tidak dibuka; hanya ditegaskan sebagai boundary.

## 11. Bukti

| Item | Nilai |
|---|---|
| Branch | `arena/44e8ce22-handyman-backend` |
| HEAD saat review | `eb9024c0fe05f492fd06cf3d293fa164e2daadd9` |
| Ancestry | `main` = `9602991`; branch 21 ahead / 0 behind (fast-forward) |
| Working tree saat masuk | bersih (`.gitignore` sudah ada sejak `56e529c`, tidak ada tracked file yang tertelan: `git ls-files -i -c --exclude-standard` kosong) |
| Perubahan PART ini | dokumen ini saja; nol perubahan `src/`, `tests/`, migration, permission, dan OpenAPI |
