#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: run-catalog-merge.sh \
  --manifest=/absolute/manifest.json \
  --identity-seed=/absolute/identity-seed.json \
  --user-email=tenant@example.com \
  --sha256=<manifest-sha256> \
  --identity-sha256=<identity-seed-sha256>
EOF
  exit 64
}

manifest=""
identity_seed=""
user_email=""
manifest_sha256=""
identity_sha256=""

for argument in "$@"; do
  case "$argument" in
    --manifest=*) manifest="${argument#*=}" ;;
    --identity-seed=*) identity_seed="${argument#*=}" ;;
    --user-email=*) user_email="${argument#*=}" ;;
    --sha256=*) manifest_sha256="${argument#*=}" ;;
    --identity-sha256=*) identity_sha256="${argument#*=}" ;;
    *) usage ;;
  esac
done

[[ -n "$manifest" && -r "$manifest" ]] || usage
[[ -n "$identity_seed" && -r "$identity_seed" ]] || usage
[[ -n "$user_email" ]] || usage
[[ "$manifest_sha256" =~ ^[a-f0-9]{64}$ ]] || usage
[[ "$identity_sha256" =~ ^[a-f0-9]{64}$ ]] || usage
[[ -r ecosystem.config.cjs ]] || {
  echo "Run this command from the deployed application root." >&2
  exit 64
}

cli=(
  npx tsx scripts/merge-catalog-duplicates.ts
  "--manifest=$manifest"
  "--identity-seed=$identity_seed"
  "--user-email=$user_email"
)

# Fail fast while both services are still available. Apply repeats every live
# validation after the writers are drained and while its database locks hold.
"${cli[@]}"

restore_services() {
  local original_status=$?
  local restore_status=0
  trap - EXIT INT TERM
  set +e
  pm2 startOrReload ecosystem.config.cjs --only dexo-api
  (( $? == 0 )) || restore_status=1
  pm2 startOrReload ecosystem.config.cjs --only dexo-sync-orders
  (( $? == 0 )) || restore_status=1
  pm2 save
  (( $? == 0 )) || restore_status=1
  if (( original_status != 0 )); then
    exit "$original_status"
  fi
  exit "$restore_status"
}

trap restore_services EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Drain the sync writer first. Its graceful shutdown can take up to 60 seconds,
# during which the API remains online. API downtime starts only after this ends.
pm2 stop dexo-sync-orders
pm2 stop dexo-api

CATALOG_MERGE_WORKERS_DRAINED=1 "${cli[@]}" \
  --apply \
  --confirmar \
  "--sha256=$manifest_sha256" \
  "--identity-sha256=$identity_sha256"
