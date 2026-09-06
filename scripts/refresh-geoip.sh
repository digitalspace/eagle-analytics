#!/usr/bin/env bash
set -euo pipefail

# Download the MaxMind GeoLite2 city database and replace the copy in the analytics storage account.
# Run monthly by .github/workflows/refresh-geoip.yaml, or by hand with the same arguments.

usage() {
  cat <<'EOF'
refresh-geoip.sh (--resource-group NAME | --account NAME) [options]

  -g, --resource-group NAME  resource group holding the analytics storage account. The account is
                             found in it by the `analyticsfc` prefix, because its name carries a
                             uniqueString suffix that cannot be composed.
  -a, --account NAME         storage account, when you would rather name it than have it looked up.
      --edition ID           MaxMind edition (default GeoLite2-City)
      --container NAME       blob container (default geoip)
      --blob NAME            blob name (default <edition>.mmdb, which is what src/ingest/enrich-geo.js
                             opens)

  MAXMIND_LICENSE_KEY   required. A GitHub secret in CI; there is no Key Vault for it.

  Storage has no access keys (allowSharedKeyAccess: false), so the caller must already be logged in
  and hold Storage Blob Data Contributor on the account.
EOF
}

RESOURCE_GROUP=''
ACCOUNT=''
EDITION='GeoLite2-City'
CONTAINER='geoip'
BLOB=''

while [ $# -gt 0 ]; do
  case "$1" in
    -g|--resource-group) RESOURCE_GROUP="${2:-}"; shift 2 ;;
    -a|--account) ACCOUNT="${2:-}"; shift 2 ;;
    --edition) EDITION="${2:-}"; shift 2 ;;
    --container) CONTAINER="${2:-}"; shift 2 ;;
    --blob) BLOB="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "✗ unknown argument '$1'." >&2; usage >&2; exit 2 ;;
  esac
done

BLOB="${BLOB:-${EDITION}.mmdb}"

if [ -z "${MAXMIND_LICENSE_KEY:-}" ]; then
  echo "✗ MAXMIND_LICENSE_KEY is not set. See --help." >&2
  exit 2
fi

if [ -z "$ACCOUNT" ]; then
  if [ -z "$RESOURCE_GROUP" ]; then
    echo "✗ pass --resource-group or --account. See --help." >&2
    exit 2
  fi
  mapfile -t FOUND < <(az storage account list -g "$RESOURCE_GROUP" \
    --query "[?starts_with(name, 'analyticsfc')].name" -o tsv --only-show-errors)
  if [ "${#FOUND[@]}" -ne 1 ]; then
    echo "✗ expected one analyticsfc* storage account in ${RESOURCE_GROUP}, found ${#FOUND[@]}." >&2
    exit 1
  fi
  ACCOUNT="${FOUND[0]}"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Downloading ${EDITION} from MaxMind…"
# The licence key travels through curl's config on stdin, not in argv: an argument is readable by
# anyone who can list processes on the runner.
curl --fail --silent --show-error --location --output "${WORK}/db.tar.gz" --config - <<CURLRC
url = "https://download.maxmind.com/app/geoip_download?edition_id=${EDITION}&license_key=${MAXMIND_LICENSE_KEY}&suffix=tar.gz"
CURLRC

# The archive holds one dated directory; the database is the only file taken out of it.
tar -xzf "${WORK}/db.tar.gz" -C "$WORK" --strip-components=1 --wildcards '*.mmdb'
DB="${WORK}/${EDITION}.mmdb"
[ -f "$DB" ] || { echo "✗ no ${EDITION}.mmdb in the downloaded archive." >&2; exit 1; }

# A truncated or error-page download still extracts on some tar builds; the real city database is
# tens of megabytes, so anything under 10 MB is not it.
SIZE="$(stat -c %s "$DB")"
if [ "$SIZE" -lt 10000000 ]; then
  echo "✗ ${DB} is only ${SIZE} bytes. Refusing to upload it." >&2
  exit 1
fi

echo "Uploading ${BLOB} (${SIZE} bytes) to ${ACCOUNT}/${CONTAINER}…"
az storage blob upload \
  --auth-mode login \
  --account-name "$ACCOUNT" \
  --container-name "$CONTAINER" \
  --name "$BLOB" \
  --file "$DB" \
  --overwrite \
  --only-show-errors \
  --output none

echo "✓ ${ACCOUNT}/${CONTAINER}/${BLOB} replaced. Running instances pick it up as they recycle."
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  echo "\`${BLOB}\` uploaded to \`${ACCOUNT}/${CONTAINER}\` (${SIZE} bytes)." >> "$GITHUB_STEP_SUMMARY"
fi
