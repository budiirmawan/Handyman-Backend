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
railway --version
railway login --browserless
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
# If your CLI requires it: railway ssh -s <backend-service> -e production
```

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

### 3.2 Safe alternative if `railway ssh` is not available

Use a controlled one-shot execution inside Railway only:

1. Open the Railway dashboard in the phone browser.
2. Select the production project → environment → **backend web service**.
3. Open the service **Shell** (web terminal). This is a TTY inside the same
   private network, so it can reach PostgreSQL without a public endpoint.
4. Run the same `node dist/database/cli.js ...` commands there.

Do **not** enable a PostgreSQL TCP proxy or `0.0.0.0` binding to make the
database reachable from Termux. `railway run` from Termux executes locally and
will not reach a private Railway database; it is not a substitute for a
container shell.

---

## 4. Minimum authorized database privileges

Use the Railway PostgreSQL **Query** tab (or a `psql` session inside the
database container) for these grants. Do not grant to `PUBLIC`.

The application runtime role needs only DML + connect privileges:

```sql
-- Replace placeholders. Never paste the role password into chat.
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

The bootstrap additionally needs (already covered above):

- `SELECT to_regclass(...)` — catalogue read,
- `LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE` — requires an UPDATE/DELETE/
  TRUNCATE privilege on `users` (granted above),
- `pg_advisory_xact_lock(...)` — available to all roles by default.

Migration `0452` requires DDL. If migrations run under a separate migration
role, grant it `CREATE ON SCHEMA public` and table ownership/ALTER rights on
`authentication_audit_events` (the migration replaces one CHECK constraint).
If the current deployment uses the Railway `postgres` superuser for
migrations, no extra grant is needed. **Do not change production credentials
as part of this CR.**

For tables created later, either re-run the grants or set defaults:

```sql
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "<runtime_role>";
```

---

## 5. Apply the additive migration

Still inside the container shell:

```bash
node dist/database/cli.js migrate
node dist/database/cli.js bootstrap-status
```

Expected: `Applied 0452_create_iam_owner_bootstrap_state` (or
`No pending migrations` if already applied), then the status block from §3.1.
The migration is additive and transactional; an interrupted run can be
retried.

---

## 6. Create the first Owner

Run from the interactive container shell. The password is prompted twice and
is **not echoed**:

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
- Never pipe it with `echo`/`printf`.
- If the policy rejects the password, the prompt retries (up to 3 attempts)
  without creating any state.
- Ctrl-C aborts before any database write.

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
  cannotManageUsers: (.data.access.permissions | index("user.manage") == null)
}'
```

Expected: `roles: ["CUSTOMER_CARE"]`, the scoped Building ids, care capability
`true`, user management `false`.

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
change it:

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
