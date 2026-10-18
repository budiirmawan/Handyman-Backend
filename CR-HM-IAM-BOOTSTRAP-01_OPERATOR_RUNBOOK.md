# CR-HM-IAM-BOOTSTRAP-01 — Production Operator Runbook

Audience: the Android/Termux operator who creates the **first and only**
Owner account on the Handyman production database.

> **DO NOT RUN THIS IN ARENA OR AGAINST A LIVE DATABASE FROM THIS WORKSPACE.**
> This runbook is executed by the human operator against Railway, after the
> reviewed image containing this CR is deployed.

---

## 0. What this creates

Exactly one `PLATFORM_ADMIN` account plus the canonical persona roles
(`SYSTEM_ADMIN`, `CUSTOMER_CARE`, `OPERATIONS`, `MANAGER`, `MOBILE_STAFF`).
It creates **no** Client, Property or Building assignment, so existing
tenant/Building isolation is untouched. It cannot be run twice.

The command surface is the compiled database CLI already shipped in the
production image:

```
node dist/database/cli.js migrate
node dist/database/cli.js bootstrap-status
node dist/database/cli.js bootstrap-owner --email <email> --display-name <name>
```

There is **no HTTP bootstrap endpoint**. The password is read from the
controlling terminal with echo disabled; it is never accepted as an argument,
environment variable or pipe.

---

## 1. Preconditions (do not skip)

- [ ] The PR for this CR is merged and a backend image containing migration
      `0452_create_iam_owner_bootstrap_state` is deployed to the Railway
      service.
- [ ] You can confirm `public.users` has **0 rows** and `public.roles` has
      **0 rows** (the expected production state for this CR).
- [ ] A recent Railway PostgreSQL backup/snapshot exists, and you know how to
      restore it. Bootstrap is one-time; undoing it requires a database
      restore, not a rerun.
- [ ] `SCHEDULER_ENABLED=false` during the operation (the deployment matrix
      already recommends this during provisioning/validation).
- [ ] You have Owner-level access to the Railway project and the deployment
      service.
- [ ] You have the Owner email address and a strong password (≥ 8 chars,
      ≤ 72 bytes) that is **not** written in chat, notes or shell history.

---

## 2. Termux setup

```bash
pkg update
pkg install nodejs-lts jq curl openssh
npm install -g @railway/cli
railway --version          # must be a current release; `railway upgrade` otherwise
railway login --browserless

# `railway ssh` authenticates with an SSH key registered to your Railway
# account (current CLI). Generate one on the phone if you do not have one:
[ -f ~/.ssh/id_ed25519 ] || ssh-keygen -t ed25519 -C "termux-operator"
railway ssh keys add --key ~/.ssh/id_ed25519.pub --name "termux-operator"
railway ssh keys            # confirm the key is listed
```

`railway login --browserless` prints a device-code URL. Complete it in your
phone browser. **Never paste a Railway token, database password or session
token into chat.**

If `railway ssh` is unavailable on your plan/CLI version, see §3.2.

---

## 3. Verify the correct Railway project, service and database

### 3.1 Link and inspect

From the Termux home directory (not from a copy of this repository; the
production image holds the compiled CLI):

```bash
railway link
# Select: project = Handyman-Backend (production project),
#         environment = production,
#         service = the backend web service (not the Postgres service).

railway status
```

`railway status` must show the production project/environment and the backend
web service. If it shows another project or a preview environment, stop.

Open an interactive shell **inside the running backend container**:

```bash
railway ssh --service <backend-service> --environment production
# Equivalent short form: railway ssh -s <backend-service> -e production
# On a flaky mobile network use the persistent session:
#   railway ssh --session production
```

Two facts that this procedure depends on (verified against the Railway CLI
documentation, 2026):

- `railway ssh` uses your system SSH client and **autodetects PTY
  allocation**: a PTY is allocated only when **both stdin and stdout are
  terminals**. Running it from Termux with no pipes does allocate a PTY, so
  `/dev/tty` exists. Piping input or output into it does **not** allocate a
  PTY.
- `railway run` / `railway shell` execute **on your phone**, not in the
  container. They cannot reach a private Railway database and are never a
  substitute here.

**TTY preflight (mandatory).** Inside the container shell, before anything
else:

```bash
node -e "require('fs').openSync('/dev/tty','r'); require('fs').openSync('/dev/tty','w'); console.log('TTY_OK')"
```

`TTY_OK` must print. If it throws `ENXIO`/`ENOENT`, the shell has no
controlling terminal: **stop** — the bootstrap would fail closed by design.
Use one of the alternatives in §3.2.

Inside the container verify the Railway identity:

```bash
printenv RAILWAY_PROJECT_NAME RAILWAY_ENVIRONMENT_NAME RAILWAY_SERVICE_NAME
node dist/database/cli.js bootstrap-status
```

`bootstrap-status` prints `Connected <host>:<port>/<database>`. The host must
be the Railway **private** PostgreSQL host (for example
`postgres.railway.internal`), port `5432`, and the expected production
database name. It never prints the password.

Expected result:

```
Schema ready: yes
Users table ready: yes
Users in database: 0
Bootstrap completed: no
Ready: run bootstrap-owner from an interactive terminal.
```

If `Schema ready` is `no`, apply the migration first (§5). If
`Users in database` is not `0`, **stop**: this database already has accounts
and the bootstrap will refuse.

### 3.2 Alternatives when `railway ssh` (or its PTY) is not available

Order of preference:

1. **Persistent tmux session** — `railway ssh --session production`. Railway
   installs tmux in the container if it is missing; the PTY is allocated the
   same way as above, and a dropped mobile connection does not kill the
   bootstrap prompt.
2. **Railway dashboard web shell** — dashboard → production project →
   environment → **backend web service** → Shell. It is a browser terminal
   inside the same private network and always has a TTY.
3. **Allocate a PTY explicitly** inside a non-interactive `railway ssh`
   command (only needed if the autodetection above does not apply):

   ```bash
   railway ssh -- \
     script -qec 'node dist/database/cli.js bootstrap-owner --email <email> --display-name "<name>"' /dev/null
   # `script` allocates a PTY, so /dev/tty exists for the hidden prompt.
   # Only the non-secret identity flags appear in that command line.
   ```

   The slim Debian production image ships `script` (util-linux). If it is
   missing, use option 1 or 2 — do **not** invent a non-interactive password
   source.

Do **not** enable a PostgreSQL TCP proxy or `0.0.0.0` binding to make the
database reachable from Termux.

---

## 4. Database roles and minimum privileges

This procedure uses **two** database roles. They are different authorities and
must not be conflated:

| Purpose | Role | Privileges used |
|---|---|---|
| Migration 0452 (DDL) | privileged **migration role** — the database owner / `postgres`, or a dedicated `<migration_role>` | `CREATE ON SCHEMA public`, `ALTER TABLE` on `authentication_audit_events` (the migration replaces one CHECK constraint), `CREATE TABLE` for `iam_bootstrap_state`, write on `schema_migrations` |
| Owner bootstrap + runtime | restricted application role — **`hm_app`** in this deployment | `CONNECT`, `USAGE` on `public`, `SELECT/INSERT/UPDATE/DELETE` on the IAM tables, `SELECT` on `schema_migrations`, sequence `USAGE` |

**Migration 0452 must never run as `hm_app`.** It is deliberately not granted
`CREATE`/`ALTER`; running `migrate` with that role fails closed (the DDL
transaction rolls back and nothing is recorded). Conversely, the bootstrap
does **not** need DDL: it runs as `hm_app` with only the DML below.

### 4.1 Grants for the application role (`hm_app`)

Run these in the Railway PostgreSQL **Query** tab (or `psql` inside the
database service). Do not grant to `PUBLIC`.

```sql
GRANT CONNECT ON DATABASE "<database_name>" TO "<runtime_role>";
GRANT USAGE ON SCHEMA public TO "<runtime_role>";

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE users,
           user_credentials,
           roles,
           permissions,
           user_role_assignments,
           role_permission_assignments,
           authentication_audit_events,
           iam_bootstrap_state
  TO "<runtime_role>";

GRANT SELECT ON TABLE schema_migrations TO "<runtime_role>";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "<runtime_role>";
```

Why each bootstrap statement is covered:

- `SELECT to_regclass(...)` and `SELECT count(*) FROM users` — catalogue +
  table read,
- `LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE` — requires an
  `UPDATE`/`DELETE`/`TRUNCATE` privilege on `users` (granted above),
- inserts into `user_credentials`, `roles`, `permissions`,
  `role_permission_assignments`, `user_role_assignments`, `users`,
  `iam_bootstrap_state` and `authentication_audit_events`,
- `pg_advisory_xact_lock(...)` — available to every role; no grant needed.

`bootstrap-status` needs only `SELECT` on `users` and `iam_bootstrap_state`.

For tables created later, either re-run the grants or set defaults:

```sql
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "<runtime_role>";
```

**Do not change production credentials as part of this CR.**

---

## 5. Backup, verify, then migrate (migration role)

### 5.1 Backup before touching the schema

1. Railway dashboard → **PostgreSQL** service → **Backups** → create a
   backup/snapshot now. Note its timestamp and confirm it reached `Completed`.
2. Record the restore procedure and who can execute it. Bootstrap is
   one-time; the only undo for a completed bootstrap is a restore.

### 5.2 Verify the pre-migration state (read-only)

Inside the container shell (this uses the runtime `hm_app` credentials already
injected by Railway; it needs `SELECT` only):

```bash
node dist/database/cli.js status
```

Expected: the current migration count (`451` once this release is deployed and
`0452` is pending — `452` only after §5.3). The command must not show
`0452_create_iam_owner_bootstrap_state` as applied yet.

Also confirm the empty identity state (Run in the Query tab):

```sql
SELECT (SELECT count(*) FROM users) AS users,
       (SELECT count(*) FROM roles) AS roles,
       (SELECT to_regclass('public.iam_bootstrap_state')) AS bootstrap_table;
-- users = 0, roles = 0, bootstrap_table = NULL
```

If either count is not `0`, **stop**: this database is not the expected fresh
production state.

### 5.3 Run the migration with the migration role

The container's `DB_*` variables point at `hm_app`. Override them **for this
one command only**, typing the migration password at a hidden prompt so it
never enters shell history or argv:

```bash
read -r -s -p 'Migration role name: ' MIGRATION_ROLE; echo
read -r -s -p 'Migration role password: ' MIGRATION_PW; echo

DB_USER="$MIGRATION_ROLE" DB_PASSWORD="$MIGRATION_PW" \
  node dist/database/cli.js migrate

unset MIGRATION_ROLE MIGRATION_PW
```

Do not export the password for the rest of the session and do not add these
variables to Railway service variables.

Expected: `Applied 0452_create_iam_owner_bootstrap_state` (or
`No pending migrations` if already applied). The migration is additive and
transactional; an interrupted run can be retried.

### 5.4 Post-migration verification

```bash
node dist/database/cli.js status    # back on hm_app: 452 applied, latest 0452
node dist/database/cli.js bootstrap-status
```

`bootstrap-status` must show `Schema ready: yes`, `Users in database: 0`,
`Bootstrap completed: no`.

---

## 6. Create the first Owner

Run this **as the application role (`hm_app`)** — the container already has
its `DB_*` variables, so no override is needed. The bootstrap needs only DML;
do not run it as the migration/superuser role.

Preflight (must print `TTY_OK`, see §3.1). If it does not, use §3.2 — the CLI
fails closed rather than reading a password from stdin, a pipe or an
environment variable.

The password is prompted twice and is **not echoed**:

```bash
node dist/database/cli.js bootstrap-owner \
  --email "owner@your-domain.example" \
  --display-name "Platform Owner"
```

Then:

```
First-owner password (input hidden):        <type, no echo>
Confirm first-owner password (input hidden): <type, no echo>
```

Rules:

- Never add `--password`. The CLI rejects it before connecting.
- Never export the password as an environment variable.
- Never pipe it with `echo`/`printf`; piped stdin has no TTY and the CLI
  aborts.
- If the policy rejects the password, the prompt retries (up to 3 attempts)
  without creating any state.
- Ctrl-C aborts before any database write.
- The prompt reads `/dev/tty`; it works under `railway ssh` (interactive) and
  under the `script` wrapper in §3.2, not under `railway run`.

Successful output (no secret material):

```
First-owner bootstrap complete.
  Owner user id: <uuid>
  Email: owner@your-domain.example
  Display name: Platform Owner
  Roles: PLATFORM_ADMIN
  Effective permissions: <n>
  Canonical persona roles created: SYSTEM_ADMIN, CUSTOMER_CARE, OPERATIONS, MANAGER, MOBILE_STAFF
  Bootstrapped at: <timestamp>
  The password is not stored, printed or recoverable here.
```

The whole operation is one transaction: a crash, Ctrl-C or database error
leaves **zero** users, credentials, roles or audit rows from this run. Simply
rerun. After commit, `bootstrap-status` reports `Bootstrap completed: yes`.

The Owner credential is created with `must_change_password = false` because
the operator chose the password directly at the hidden prompt. Accounts
created later through an administrative reset start with
`must_change_password = true` and are gated (see §9.1).

---

## 7. Verify the Owner login and effective permissions

On the phone (Termux), with the API base URL of the production backend:

```bash
API="https://<backend-production-host>"

read -r -p 'Owner email: ' OWNER_EMAIL
read -r -s -p 'Owner password: ' OWNER_PW; echo

# Password travels on stdin (jq), never in curl/jq argv.
LOGIN=$(printf '%s' "$OWNER_PW" | \
  jq -Rs --arg e "$OWNER_EMAIL" '{email:$e, password:.}' | \
  curl -sS -X POST "$API/api/v1/auth/login" \
       -H 'content-type: application/json' --data-binary @-)
unset OWNER_PW

TOKEN=$(printf '%s' "$LOGIN" | jq -r '.data.sessionToken // empty')
unset LOGIN
test -n "$TOKEN" || { echo 'LOGIN FAILED'; exit 1; }

curl -sS "$API/api/v1/auth/me" -H "Authorization: Bearer $TOKEN" | jq '{
  roles: [.data.access.roles[].code],
  canManageUsers: (.data.access.permissions | index("user.manage") != null),
  canManageRoles: (.data.access.permissions | index("role.manage") != null),
  canManagePermissions: (.data.access.permissions | index("permission.manage") != null),
  canReadAudit: (.data.access.permissions | index("auth.audit.read") != null),
  careWithheld: (.data.access.permissions | index("handyman.care.building") == null),
  financeWithheld: (.data.access.permissions | index("handyman.finance.manage") == null),
  platformWithheld: (.data.access.permissions | index("platform.customer.read") == null)
}'
```

Expected: `roles: ["PLATFORM_ADMIN"]`, the four `can*` flags `true`, and the
three `*Withheld` flags `true`. Do not print `$TOKEN`; clear it when finished:

```bash
unset TOKEN
```

---

## 8. Create and verify a Customer Care account

The supported lifecycle is invitation → acceptance → role assignment. The
invitee chooses their own password; the Owner never sets it.

### 8.1 Create the invitation (Owner token required)

```bash
CARE_EMAIL="care-test@your-domain.example"

INVITE=$(curl -sS -X POST "$API/api/v1/invitations" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"email\":\"$CARE_EMAIL\"}")
printf '%s' "$INVITE" | jq '.data | {id,email,expiresAt}'
INVITE_TOKEN=$(printf '%s' "$INVITE" | jq -r '.data.invitationToken')
unset INVITE
```

Deliver `$INVITE_TOKEN` to the invitee out-of-band (secure messenger or
in person). Do not paste it into chat or email in plain text. It is
single-use and expires (default 72 h).

### 8.2 The invitee accepts

```bash
read -r -p 'Invitation token: ' TOKEN_INPUT
read -r -p 'Display name: ' DISPLAY_NAME
read -r -s -p 'Choose password: ' NEW_PW; echo

printf '%s\n%s' "$TOKEN_INPUT" "$NEW_PW" | \
  jq -Rs --arg n "$DISPLAY_NAME" \
     'split("\n") | {token:.[0], displayName:$n, password:.[1]}' | \
  curl -sS -X POST "$API/api/v1/invitations/accept" \
       -H 'content-type: application/json' --data-binary @- | jq '.data.user | {id,email,status}'

unset NEW_PW TOKEN_INPUT
```

### 8.3 Assign the CUSTOMER_CARE role (Owner)

```bash
CARE_USER_ID=$(curl -sS "$API/api/v1/users?email=$CARE_EMAIL" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.data[0].id')

CARE_ROLE_ID=$(curl -sS "$API/api/v1/roles" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.data[] | select(.code=="CUSTOMER_CARE") | .id')

curl -sS -X POST "$API/api/v1/users/$CARE_USER_ID/roles" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"roleId\":\"$CARE_ROLE_ID\"}" | jq '{code,name}'
```

Scope the account to the exact Buildings it may serve (no global access):

```bash
curl -sS -X POST "$API/api/v1/users/$CARE_USER_ID/buildings" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"buildingId":"<building-uuid>"}' | jq '.data | {userId,buildingId,status}'
```

Repeat per Building. Assigning the role without a Building assignment grants
**capability, not data** — the existing BE-02G isolation still denies every
unassigned Building.

### 8.4 Verify the Care account

Log in as the Care user exactly as in §7 (store the token as
`CARE_TOKEN`), then:

```bash
curl -sS "$API/api/v1/auth/me" -H "Authorization: Bearer $CARE_TOKEN" | jq '{
  roles: [.data.access.roles[].code],
  buildings: .data.scope.buildingIds,
  careCapability: (.data.access.permissions | index("handyman.care.building") != null),
  cannotManageUsers: (.data.access.permissions | index("user.manage") == null),
  cannotTenantManage: (.data.access.permissions | index("tenant_company.manage") == null)
}'
```

Expected: `roles: ["CUSTOMER_CARE"]`, the scoped Building ids, care capability
`true`, user management and tenant-wide management `false`.

The Customer Care role deliberately does **not** hold
`tenant_company.manage`: that coarse code gates dispatch release/cancel, BAST
customer acceptance, customer-payment recording, lifecycle triage/diagnosis
and material purchasing. The Care persona mediates requests through
`handyman.care.building` + `service_request.manage` instead (§9).

---

## 9. Verify unauthorized privilege escalation is denied

Using the Care token:

```bash
# 1. Cannot list accounts (403).
curl -sS -o /dev/null -w '%{http_code}\n' "$API/api/v1/users" \
  -H "Authorization: Bearer $CARE_TOKEN"

# 2. Cannot create accounts (403).
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$API/api/v1/users" \
  -H "Authorization: Bearer $CARE_TOKEN" -H 'content-type: application/json' \
  -d '{"email":"escalation@example.com","displayName":"Escalation"}'

# 3. Cannot grant permissions (403).
curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
  "$API/api/v1/roles/<some-role-id>/permissions" \
  -H "Authorization: Bearer $CARE_TOKEN" -H 'content-type: application/json' \
  -d '{"permissionId":"<some-permission-id>"}'

# 4. Cannot reset the Owner password (403).
curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
  "$API/api/v1/users/<owner-user-id>/password-reset" \
  -H "Authorization: Bearer $CARE_TOKEN" -H 'content-type: application/json' \
  -d '{"newPassword":"TakeoverAttempt123"}'
```

All four must print `403`.

### 9.1 Mandatory password change (server-enforced)

Reset a throwaway account's password (as Owner), log in with the temporary
password and confirm the gate:

```bash
TEMP_TOKEN=...   # session token from the login with the temporary password

# Allowed: the state and the own identity.
curl -sS "$API/api/v1/auth/password/status" -H "Authorization: Bearer $TEMP_TOKEN"
# → {"data":{"mustChangePassword":true}}

# Refused: everything else, including read-only administration.
curl -sS -o /dev/null -w '%{http_code}\n' "$API/api/v1/users" \
  -H "Authorization: Bearer $TEMP_TOKEN"
# → 403  (error.code = PASSWORD_CHANGE_REQUIRED)

# Allowed: logout with that same token.
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$API/api/v1/auth/logout" \
  -H "Authorization: Bearer $TEMP_TOKEN"
```

### 9.2 Privileged-account protection

As a **SYSTEM_ADMIN** (not the Owner), all of these must return `403` with
`PRIVILEGED_ACCOUNT_PROTECTED`:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
  "$API/api/v1/users/<owner-user-id>/suspend" -H "Authorization: Bearer $SYSADMIN_TOKEN"
curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
  "$API/api/v1/users/<owner-user-id>/deactivate" -H "Authorization: Bearer $SYSADMIN_TOKEN"
curl -sS -o /dev/null -w '%{http_code}\n' -X PATCH \
  "$API/api/v1/users/<owner-user-id>/whatsapp-contact" \
  -H "Authorization: Bearer $SYSADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"whatsappPhone":"+628123456789","consent":"OPT_IN"}'
```

As the **Owner**, suspending/deactivating your own account must return `403`
`SELF_ACCOUNT_ACTION_DENIED`. A `SYSTEM_ADMIN` with `role.manage` (a deliberate
delegation by the Owner) must still receive `403
PRIVILEGED_ROLE_ASSIGNMENT_DENIED` when assigning `PLATFORM_ADMIN`.

Finally confirm the bootstrap cannot be repeated:

```bash
node dist/database/cli.js bootstrap-owner --email other@example.com --display-name Other
```

Expected: exit 1 with `IAM_BOOTSTRAP_ALREADY_COMPLETED`; the users count stays
at 1.

---

## 10. Password reset procedure (post-bootstrap)

Owner / System Admin with `user.manage` resets a user:

```bash
read -r -s -p 'Temporary password: ' TEMP_PW; echo
printf '%s' "$TEMP_PW" | jq -Rs '{newPassword:.}' | \
  curl -sS -X POST "$API/api/v1/users/<user-id>/password-reset" \
       -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
       --data-binary @-
unset TEMP_PW
```

Result: `{ "reset": true, "mustChangePassword": true }`. **Every** session for
that user is already revoked; they must log in with the temporary password and
change it. Until the change succeeds, every other authenticated operation
returns `403 PASSWORD_CHANGE_REQUIRED` (only `GET /auth/password/status`,
`POST /auth/password`, `POST /auth/logout` and `GET /auth/me` stay reachable):

```bash
# As the user:
read -r -s -p 'Current (temporary) password: ' CUR_PW; echo
read -r -s -p 'New password: ' NEW_PW; echo
printf '%s\n%s' "$CUR_PW" "$NEW_PW" | jq -Rs 'split("\n") | {currentPassword:.[0], newPassword:.[1]}' | \
  curl -sS -X POST "$API/api/v1/auth/password" \
       -H "Authorization: Bearer $USER_TOKEN" -H 'content-type: application/json' \
       --data-binary @-
unset CUR_PW NEW_PW
```

Resetting an account that holds `PLATFORM_ADMIN` requires the caller to also
hold `PLATFORM_ADMIN`; otherwise the API returns
`403 PRIVILEGED_ACCOUNT_RESET_DENIED`.

There is no API that returns an existing password or hash.

---

## 11. Interrupted / failed run recovery

| Situation | State | Action |
|---|---|---|
| Ctrl-C or CLI crash during password prompt | Nothing written | Rerun `bootstrap-owner` |
| Error inside the transaction (missing permission, DB error) | Everything rolled back | Fix the cause, rerun |
| Migration interrupted | PostgreSQL DDL transaction rolled back | Rerun `migrate` |
| `bootstrap-status` says completed | Owner exists | Do **not** rerun; use the API |
| `bootstrap-owner` says `USERS_EXIST` | Database is not fresh | Stop; investigate existing accounts |
| Wrong database | `bootstrap-status` host/name mismatch | Stop; relink the correct Railway project |

Never delete `iam_bootstrap_state`, users or roles to “make bootstrap run
again”. That row is the one-time guard; removing it damages the audit trail.

---

## 12. Do-not-do list

- Do not create a public PostgreSQL TCP proxy, firewall exception or
  `0.0.0.0` binding for this procedure.
- Do not pass the Owner password through argv, env vars, `echo`, a file in
  the repository, a Railway variable, or chat.
- Do not paste session tokens, invitation tokens, `DATABASE_URL` or
  `DB_PASSWORD` into chat or tickets.
- Do not run `bootstrap-owner` against a database that already has users.
- Do not grant `PLATFORM_ADMIN` to a Customer Care / Operations / Manager /
  Mobile account “just to test”; test escalation with the real scoped roles.
- Do not change production credentials as part of this CR.

---

## 13. Remaining blockers (not solved by this runbook)

| Class | Blocker | Effect on this procedure |
|---|---|---|
| Security | No MFA for the Owner; login throttling is per-instance in memory | Single-credential Owner. Accept the residual risk for the first window and schedule MFA |
| Resilience | No second Owner by default | After §9, assign `PLATFORM_ADMIN` to a second trusted person so Owner recovery does not depend on one phone/password |
| Delivery | No automated invitation-token or reset-notice channel (`EMAIL_PROVIDER=noop`, no WhatsApp template) | Hand tokens over out-of-band; never paste them into chat |
| Frontend | No user-management, forced-change or role-assignment screens | Operator uses the documented API calls in §8–§10 until the UI ships |
| Frontend | `mustChangePassword` is served by `GET /auth/password/status`, not by `/auth/me` (whose shape is frozen) | The client must call the status endpoint after login |
| Authorization | `tenant_company.manage` remains the coarse gate for OPERATIONS and the Owner on dispatch/tenant-transport surfaces | Keep those accounts to explicit persona roles; a dedicated dispatch permission is a follow-up CR |
| Data | The last-owner guards are enforced in one process transaction with an advisory lock | Two application replicas are safe (the lock is database-wide); a manual SQL edit is not |
| Data | `SUSPENDED` → `ACTIVE` has no API path (reactivate accepts `INACTIVE` only) | Reserve suspension for security incidents; reinstatement needs a controlled DBA update. Self/owner suspension is blocked server-side |
| Platform | Railway plan/CLI must support SSH with an interactive PTY | Verified in §3.1 before any write; fall back to the dashboard shell |

Resetting a **protected** account is denied to a non-owner; suspending,
deactivating or changing the WhatsApp contact of a protected account is
equally denied (`403 PRIVILEGED_ACCOUNT_PROTECTED`). The last active Owner
account cannot be deactivated or suspended, and an administrator cannot apply
a lifecycle transition to their own account (`403 SELF_ACCOUNT_ACTION_DENIED`).
