# CR-HM-07 — PART 03 LOCATION SIGNAL + API.CO.ID GOVERNANCE (FROZEN)

**Status: FROZEN GOVERNANCE, base `323692a`, 2026-09-28.** Docs-only:
NO runtime, NO migration, NO tests, NO HTTP/OpenAPI. PART 03 is split:
03A (this freeze) governance ONLY; 03B (runtime) requires a
separate explicit mandate. Sources read (read-only):
`CR-HM-07_START_GOVERNANCE.md` §C/§H/§I (location/result model),
CR-HM-04 activation certification §5/§6, PART 01/02 runtimes
(challenge, expected-location resolver, QR registry/signal).

## 1. INTERNAL AUTHORITY

The immutable **CR-HM-06 Execution Scope expected-location snapshot**
(`resolveHandymanExpectedArrivalLocation`, PART 02) remains the SOLE
expected-location authority. Nothing in this freeze — device
location, geofence output, reverse-geocode metadata, regional
references — may replace, dilute, or extend it.

## 2. DEVICE LOCATION INPUT

A future PART 03B runtime MAY accept, verbatim, exactly:

`latitude`, `longitude`, `accuracyMeters`, `capturedAt`

These are **device signals, NOT authority** (governance §H: stored as
observed-signal evidence only; they define nothing about expected
location; NO silent fabrication ever). Future runtime must NEVER
accept caller-derived: expected location, distance, `insideGeofence`,
regional identity, arrival verdict — each is server-computed or
forbidden.

## 3. GEOFENCE

The Handyman Backend calculates distance/geofence **internally**
(server-side geometry against the expected-location authority's
Building coordinates — never device-asserted results). Geofence is a
**RISK/CORROBORATION SIGNAL only** (governance §H).

Bounded signal vocabulary:

`INSIDE` | `OUTSIDE` | `LOW_ACCURACY` | `UNAVAILABLE`

- GPS absent/permission denied → `UNAVAILABLE` (never fabricated);
- low reading accuracy → `LOW_ACCURACY` (accuracy metadata kept
  verbatim);
- Geofence alone NEVER produces a VERIFIED/FAILED arrival verdict;
  it may only contribute downgrade/risk flags to a later composed
  result.

## 4. API.CO.ID SCOPE

Permitted API.CO.ID usage, exact and exhaustive:

- **Reverse Geocoding**;
- **Regional Indonesia** reference data.

**No other API.CO.ID capability belongs to the current Handyman
scope.** No enrichment catalogs, no other vendor datasets, no
billing/compute features.

## 5. PROVIDER ABSTRACTION

Domain/business services must NEVER call API.CO.ID directly.
Conceptually frozen interfaces (PART 03B materializes them):

```
LocationEnrichmentProvider
  reverseGeocode(latitude, longitude) → normalized enrichment

RegionalReferenceProvider
  resolve/normalize Indonesian region references

ApiCoIdLocationAdapter (implements both against API.CO.ID)
```

API keys are **server-side secrets only** (config injection; never in
code, requests, events, or logs).

## 6. REVERSE GEOCODING

Purpose: **enrich/corroborate** device GPS coordinates with
address/region metadata (OPTIONAL corroboration layer).

It is NOT: expected-location authority, NOT geofence authority,
NOT arrival verdict authority.

Provider timeout/error maps to the bounded state
`REVERSE_GEOCODE_UNAVAILABLE`. An arrival composition MUST NEVER
automatically FAIL solely because API.CO.ID is unavailable —
unavailability degrades the corroboration layer only (§H-consistent).

## 7. REGIONAL INDONESIA

Purpose: normalize/reference Indonesian regional taxonomy:

province, regency/city, district, village/subdistrict (kelurahan/
desa), postal code, plus provider identifiers where available.

The internal Handyman/building location masters (building → floor →
area → room → space) remain the ONLY operational location authority.
Regional Indonesia reference data does NOT replace, alias, or
shadow building/floor/area/room/space semantics.

## 8. NORMALIZATION

Reverse-geocode provider output MUST pass through adapter
normalization: business/domain services consume a **provider-neutral
normalized result**, never a raw API.CO.ID payload. Raw provider
responses are preserved ONLY if a later mandate explicitly requires
raw payload persistence for diagnostic/audit policy — raw payload
persistence is deliberately NOT frozen now.

## 9. RELIABILITY

Every external provider call must have:

- explicit **timeout** (bounded, documented at PART 03B);
- bounded error mapping (→ `REVERSE_GEOCODE_UNAVAILABLE` family only);
- **no secret logging** / no raw API key exposure anywhere;
- provider-neutral failure states (domain sees normalized outcome or
  the bounded unavailable state, nothing else);
- **NO external provider call inside an open DB transaction**
  (call-first, then persist, in separate steps).

## 10. ARRIVAL COMPOSITION

A future arrival decision MAY compose:

authoritative CR-HM-04 Lead (resolver)
\+ consumed PART 01 challenge
\+ PART 02 QR signal
\+ device location/geofence signal (§3)
\+ optional reverse-geocode/regional corroboration (§6–§7)

**PART 03 MUST NOT implement terminal VERIFIED/FAILED** unless
separately authorized by a later PART (governance §I remains frozen
but unimplemented). No result row, lifecycle, retry, or idempotency
semantics are created by this freeze.

## 11. FIREWALL

API.CO.ID (and everything in this freeze) must NOT:

- mutate Execution Scope location (authority stays immutable);
- consume PART 01 challenges;
- change the PART 02 QR registry;
- start work / CHECK-IN;
- write attendance;
- touch payment/BAST;
- touch FM patrol/checkpoint/work_order.

## Frozen tokens

| Token | Value |
|---|---|
| API_CO_ID_SCOPE | REGIONAL_INDONESIA,REVERSE_GEOCODING |
| EXPECTED_LOCATION_AUTHORITY | HANDYMAN_EXECUTION_SCOPE |
| GEOFENCE_AUTHORITY | HANDYMAN_BACKEND |
| REVERSE_GEOCODING_ROLE | OPTIONAL_CORROBORATION |
| REGIONAL_ROLE | REFERENCE_NORMALIZATION |
| ARRIVAL_VERDICT_AUTHORITY | NOT_IMPLEMENTED |
| API_CO_ID_DIRECT_DOMAIN_DEPENDENCY | FORBIDDEN |

---

*This freeze binds PART 03B's implementation space only. It changes
no runtime, no roadmap, no certified CR document; PART 01–02
authorities and CR-HM-07 START governance remain untouched.*
