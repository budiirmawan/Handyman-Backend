# CR-HM-07 — GEOSPATIAL AUTHORITY DECISION (FROZEN)

**Status: FROZEN DECISION, base `3138316`, 2026-09-28.** Docs-only:
NO runtime, NO migration, NO tests, NO HTTP/OpenAPI, NO API.CO.ID
calls. This decision resolves the PART 03B blocker by freezing the
missing authority it reported (reference coordinates, geofence
radius, accuracy/freshness thresholds). Sources read (read-only):
`CR-HM-07_START_GOVERNANCE.md` §C/§H,
`CR-HM-07_PART03_LOCATION_SIGNAL_GOVERNANCE.md` (PART 03A freeze),
building/location master schemas (`0017`/`0018` chain).

## 1. OWNERSHIP

The Handyman domain owns a dedicated **per-Building arrival
geospatial policy**. Existing Building/location masters are NOT
modified: GPS stays opt-in policy data, never a mandatory master
field. FM patrol/checkpoint data is NEVER an authority (mandate D;
PART 03A §11). Building/location IDs remain governed by the existing
masters; the geospatial policy merely **references `buildingId`**.

## 2. MODEL (future authoritative shape)

```
HandymanBuildingGeospatialPolicy
  clientId
  buildingId
  referenceLatitude
  referenceLongitude
  geofenceRadiusMeters
  maxAccuracyMeters
  maxLocationAgeSeconds
  status           ACTIVE | INACTIVE
  effectiveFrom
  createdByUserId
  createdAt
  updatedAt
```

Exactly **one ACTIVE policy per building** (later persistence enforces
it; the pattern is the proven partial-unique precedent).

## 3. REFERENCE POINT

`referenceLatitude` / `referenceLongitude` = the authoritative arrival
reference point configured for that building. They are NOT derived
automatically from: device GPS, QR, reverse geocoding, API.CO.ID,
textual building address, or FM data. The initial value MUST be
explicitly configured by an authorized operator.

## 4. RADIUS

`geofenceRadiusMeters` is a PER-BUILDING policy value. NO global
numeric radius is frozen or invented. Validation may enforce only
physically valid positive numeric input; the business radius is
configured per building by §10 administration.

## 5. ACCURACY

`maxAccuracyMeters` is a PER-BUILDING policy value. NO global
accuracy threshold is invented. Rule (for PART 03B+ runtime):

```
device accuracyMeters > policy maxAccuracyMeters  =>  LOW_ACCURACY
```

## 6. FRESHNESS

`maxLocationAgeSeconds` is a PER-BUILDING policy value. NO global
freshness threshold is invented. A device's `capturedAt` age is
evaluated against **server time**; an observation exceeding the
configured policy is treated as an unavailable/stale signal according
to the later runtime contract. Future timestamps must fail validation
under later bounded runtime rules — an arbitrary clock-skew tolerance
is deliberately NOT frozen here.

## 7. GEOFENCE AUTHORITY (computation rule)

The Handyman Backend computes distance server-side, deterministically.

| Signal | Condition |
|---|---|
| `INSIDE` | valid device signal AND accuracy acceptable AND distance <= geofenceRadiusMeters |
| `OUTSIDE` | valid device signal AND accuracy acceptable AND distance > geofenceRadiusMeters |
| `LOW_ACCURACY` | accuracyMeters > maxAccuracyMeters |
| `UNAVAILABLE` | no ACTIVE building geospatial policy OR required usable signal absent |

**No signal alone means arrival VERIFIED/FAILED** (§H consistent).

## 8. LOCATION LEVEL

Geofence reference is **BUILDING-level** in CR-HM-07. Floor/area/
room/space verification remains QR/location-signal territory (PART 02
registry). GPS coordinates for indoor sub-locations are NEVER
invented.

## 9. API.CO.ID

API.CO.ID Reverse Geocoding remains **OPTIONAL_CORROBORATION**;
Regional Indonesia remains **REFERENCE_NORMALIZATION** (PART 03A §4–
§7). Neither may create or overwrite `referenceLatitude`,
`referenceLongitude`, `geofenceRadiusMeters`, `maxAccuracyMeters`, or
`maxLocationAgeSeconds` — provider output has ZERO geometry/policy
authority.

## 10. ADMINISTRATION

Policy mutations require an authenticated, authorized management
context. Exact HTTP/admin UI exposure is **DEFERRED** — no API is
invented in this governance PART. Policy changes must preserve
history/audit in the later persistence design (append/enable pattern,
never a silent overwrite of historical authority).

## 11. FIREWALL

This decision creates NO: arrival verdict, challenge consumption,
QR mutation, work session / CHECK-IN, attendance, payment/BAST,
FM work_order.

## Frozen tokens

| Token | Value |
|---|---|
| GEOSPATIAL_POLICY_AUTHORITY | HANDYMAN_BUILDING_GEOSPATIAL_POLICY |
| GEOSPATIAL_POLICY_SCOPE | PER_BUILDING |
| REFERENCE_COORDINATE_SOURCE | AUTHORIZED_OPERATOR_CONFIGURATION |
| GEOFENCE_RADIUS_SOURCE | PER_BUILDING_POLICY |
| ACCURACY_THRESHOLD_SOURCE | PER_BUILDING_POLICY |
| LOCATION_FRESHNESS_SOURCE | PER_BUILDING_POLICY |
| GEOFENCE_COMPUTATION_AUTHORITY | HANDYMAN_BACKEND |
| INDOOR_LOCATION_GPS_AUTHORITY | NONE |
| API_CO_ID_GEOMETRY_AUTHORITY | NO |
| API_CO_ID_ROLE | OPTIONAL_CORROBORATION_AND_REGIONAL_NORMALIZATION |

---

*This decision freezes authority ONLY. PART 03B may be re-issued to
implement against it; no runtime, roadmap, or certified CR document
is changed.*
