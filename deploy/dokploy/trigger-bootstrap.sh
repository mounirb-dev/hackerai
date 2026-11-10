#!/bin/sh
set -eu

# Headless Trigger.dev bootstrap for HackerAI.
# The file is deliberately written to a Docker volume. It is never logged and
# survives redeploys, so the app can start without a dashboard login. It must be
# readable by the app's non-root user; the volume is mounted only by the
# bootstrap job (rw) and the app (ro).

OUT="${TRIGGER_CREDENTIALS_FILE:-/run/trigger/credentials.env}"
mkdir -p "$(dirname "$OUT")"
chmod 755 "$(dirname "$OUT")"

if [ -s "$OUT" ] && grep -q '^TRIGGER_PROJECT_ID=' "$OUT" && grep -q '^TRIGGER_SECRET_KEY=' "$OUT"; then
  # With database access, make sure the stored key still exists (a fresh
  # Trigger database invalidates credentials left in an old volume).
  if [ -n "${PGPASSWORD:-}" ]; then
    until pg_isready -h "${PGHOST:-postgres}" -p "${PGPORT:-5432}" -U "${PGUSER:-postgres}" -d "${PGDATABASE:-main}" >/dev/null 2>&1; do
      sleep 2
    done
    stored_key="$(sed -n 's/^TRIGGER_SECRET_KEY=//p' "$OUT" | head -n 1)"
    found="$(printf '%s\n' "select 1 from \"RuntimeEnvironment\" where \"apiKey\" = :'key' limit 1;" | psql -X -qAt -v ON_ERROR_STOP=1 -v key="$stored_key" 2>/dev/null || true)"
    if [ "$found" != "1" ]; then
      echo "[trigger-bootstrap] stored credentials are not in this Trigger database; reprovisioning"
      rm -f "$OUT"
    fi
  fi
fi

if [ -s "$OUT" ] && grep -q '^TRIGGER_PROJECT_ID=' "$OUT" && grep -q '^TRIGGER_SECRET_KEY=' "$OUT"; then
  chmod 644 "$OUT"
  echo "[trigger-bootstrap] credentials already provisioned"
  exit 0
fi

# If Dokploy already supplied the values, persist them and do not touch the
# Trigger database. This also makes migration from the previous manual setup
# safe and idempotent.
if [ -n "${TRIGGER_PROJECT_ID:-}" ] && [ -n "${TRIGGER_SECRET_KEY:-}" ]; then
  umask 022
  {
    printf 'TRIGGER_PROJECT_ID=%s\n' "$TRIGGER_PROJECT_ID"
    printf 'TRIGGER_SECRET_KEY=%s\n' "$TRIGGER_SECRET_KEY"
  } > "$OUT"
  echo "[trigger-bootstrap] existing credentials persisted"
  exit 0
fi

: "${PGHOST:=postgres}"
: "${PGPORT:=5432}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=main}"
: "${PGPASSWORD:?TRIGGER_POSTGRES_PASSWORD is required when Trigger credentials are not supplied}"

until pg_isready -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" >/dev/null 2>&1; do
  sleep 2
done

# The postgres:alpine image has no openssl.
rand() { head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
sql_scalar() { psql -X -qAt -v ON_ERROR_STOP=1 "$@"; }

env_type="${TRIGGER_BOOTSTRAP_ENV:-DEVELOPMENT}"
case "$env_type" in PRODUCTION|DEVELOPMENT|STAGING|PREVIEW) ;; *) echo "[trigger-bootstrap] invalid TRIGGER_BOOTSTRAP_ENV" >&2; exit 1 ;; esac
project_name="${TRIGGER_BOOTSTRAP_PROJECT_NAME:-HackerAI Agent}"
user_email="${TRIGGER_BOOTSTRAP_EMAIL:-admin@hackerai.local}"

# Prefer an existing project, including the project created by the previous
# manual setup. Only the development root key is needed by the SDK.
row="$(sql_scalar -c "select p.\"externalRef\" || '|' || e.\"apiKey\" from \"Project\" p join \"RuntimeEnvironment\" e on e.\"projectId\"=p.id and e.type='$env_type' where p.name = '$project_name' and p.\"deletedAt\" is null order by p.\"createdAt\" asc limit 1;")"

if [ -z "$row" ]; then
  # psql only expands :'var' for statements read from stdin (not for -c).
  user_id="$(sql_scalar -c "select id from \"User\" where lower(email)=lower('$user_email') limit 1;")"
  if [ -z "$user_id" ]; then
    user_id="ha_user_$(rand)"
    psql -X -q -v ON_ERROR_STOP=1 -v uid="$user_id" -v email="$user_email" <<'SQL'
insert into "User" (id,email,"authenticationMethod","updatedAt","displayName",name,"confirmedBasicDetails")
values (:'uid',:'email','MAGIC_LINK',CURRENT_TIMESTAMP,'HackerAI admin','HackerAI admin',true);
SQL
  fi

  org_id="ha_org_$(rand)"
  org_slug="hackerai-$(rand | cut -c1-8)"
  member_id="ha_member_$(rand)"
  psql -X -q -v ON_ERROR_STOP=1 -v oid="$org_id" -v slug="$org_slug" -v mid="$member_id" -v uid="$user_id" <<'SQL'
insert into "Organization" (id,slug,title,"updatedAt","v3Enabled","v2Enabled","hasRequestedV3")
values (:'oid',:'slug','HackerAI',CURRENT_TIMESTAMP,true,true,true);
insert into "OrgMember" (id,"organizationId","userId",role,"updatedAt")
values (:'mid',:'oid',:'uid','ADMIN',CURRENT_TIMESTAMP);
SQL

  project_id="ha_project_$(rand)"
  project_ref="proj_$(rand | cut -c1-20)"
  project_slug="hackerai-agent-$(rand | cut -c1-8)"
  psql -X -q -v ON_ERROR_STOP=1 -v pid="$project_id" -v oid="$org_id" -v name="$project_name" -v slug="$project_slug" -v pref="$project_ref" <<'SQL'
insert into "Project" (id,name,"organizationId","updatedAt",slug,"externalRef",version,engine,"defaultRuntime")
values (:'pid',:'name',:'oid',CURRENT_TIMESTAMP,:'slug',:'pref','V3','V2','node-24');
SQL

  for env in PRODUCTION DEVELOPMENT STAGING PREVIEW; do
    case "$env" in
      PRODUCTION) slug=prod; prefix=prod ;;
      DEVELOPMENT) slug=dev; prefix=dev ;;
      STAGING) slug=stg; prefix=stg ;;
      PREVIEW) slug=preview; prefix=preview ;;
    esac
    env_id="ha_env_$(rand)"
    api_key="tr_${prefix}_$(rand | cut -c1-22)"
    pk_key="pk_${prefix}_$(rand | cut -c1-22)"
    shortcode="$(rand | cut -c1-8)"
    if [ "$env" = DEVELOPMENT ]; then
      psql -X -q -v ON_ERROR_STOP=1 -v eid="$env_id" -v slug="$slug" -v key="$api_key" -v pk="$pk_key" -v oid="$org_id" -v pid="$project_id" -v mid="$member_id" -v short="$shortcode" -v env="$env" <<'SQL'
insert into "RuntimeEnvironment" (id,slug,"apiKey","organizationId","updatedAt","orgMemberId","projectId",type,"pkApiKey",shortcode)
values (:'eid',:'slug',:'key',:'oid',CURRENT_TIMESTAMP,:'mid',:'pid',:'env',:'pk',:'short');
SQL
    else
      psql -X -q -v ON_ERROR_STOP=1 -v eid="$env_id" -v slug="$slug" -v key="$api_key" -v pk="$pk_key" -v oid="$org_id" -v pid="$project_id" -v short="$shortcode" -v env="$env" <<'SQL'
insert into "RuntimeEnvironment" (id,slug,"apiKey","organizationId","updatedAt","projectId",type,"pkApiKey",shortcode)
values (:'eid',:'slug',:'key',:'oid',CURRENT_TIMESTAMP,:'pid',:'env',:'pk',:'short');
SQL
    fi
  done
  row="$project_ref|$(sql_scalar -c "select \"apiKey\" from \"RuntimeEnvironment\" where \"projectId\"='$project_id' and type='$env_type';")"
fi

project_ref="${row%%|*}"
secret_key="${row#*|}"
if [ -z "$project_ref" ] || [ -z "$secret_key" ]; then
  echo "[trigger-bootstrap] could not resolve a $env_type environment" >&2
  exit 1
fi

umask 022
{
  printf 'TRIGGER_PROJECT_ID=%s\n' "$project_ref"
  printf 'TRIGGER_SECRET_KEY=%s\n' "$secret_key"
} > "$OUT"
chmod 644 "$OUT"
echo "[trigger-bootstrap] Trigger project provisioned"
