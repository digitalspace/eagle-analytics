#!/usr/bin/env bash
set -euo pipefail

# Bicep deployment for the eagle-analytics estate. Run by hand, never from CI: README "Deploy".

usage() {
  cat <<'EOF'
deploy-infra.sh <test|prod> [--what-if|--live]

  test defaults to --live, prod defaults to --what-if.

  All four below are required. The param files read them from the environment with no
  fallback, so a missing export fails the build rather than blanking the live setting.

  APIM_SHARED_HEADER_VALUE   the secret demi-apim-<env> stamps on a forwarded request.
  AUDIT_SHARED_HEADER_VALUE  the secret the keyed analytics-machine product stamps on
                             what it forwards to POST /audit.
  FRONT_DOOR_ID              the eagle-edge profile's own id, which decides whether
                             X-Azure-SocketIP is trusted as the client address.
  BUDGET_CONTACT_EMAIL       address the budget thresholds notify.

  CONFIRM_PROD=yes           required for prod --live.
  WHATIF_BEFORE_LIVE=1       run a what-if before a --live deploy, in the same output. Off by
                             default; a separate --what-if run is the usual way to read the diff.
EOF
}

ENVIRONMENT="${1:-test}"
MODE="${2:-}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

GREEN='\033[0;32m'; BLUE='\033[0;34m'; RED='\033[0;31m'; NC='\033[0m'

case "$ENVIRONMENT" in
  test)
    SUBSCRIPTION='7897ceb1-9a86-4639-87d7-7f9ff67142b3'
    RESOURCE_GROUP='c4b0a8-test-rg'
    [ "$MODE" = '--what-if' ] || MODE='--live'
    ;;
  prod)
    SUBSCRIPTION='be5924ac-1083-4a1b-be92-7b444882cfd9'
    RESOURCE_GROUP='rg-eagle-public-prod'
    if [ "$MODE" = '--live' ] && [ "${CONFIRM_PROD:-}" != 'yes' ]; then
      echo -e "${RED}✗ prod --live needs CONFIRM_PROD=yes.${NC}" >&2
      echo -e "${RED}  App settings are a whole-collection PUT and this group also holds the" >&2
      echo -e "  eagle-public prod estate. Run without --live first and read the what-if.${NC}" >&2
      exit 2
    fi
    [ "$MODE" = '--live' ] || MODE='--what-if'
    ;;
  -h|--help)
    usage
    exit 0
    ;;
  *)
    echo -e "${RED}✗ unknown environment '${ENVIRONMENT}'. Use 'test' or 'prod'.${NC}" >&2
    usage >&2
    exit 2
    ;;
esac

REQUIRED_VARS=(APIM_SHARED_HEADER_VALUE AUDIT_SHARED_HEADER_VALUE FRONT_DOOR_ID BUDGET_CONTACT_EMAIL)

for VAR in "${REQUIRED_VARS[@]}"; do
  if [ -z "${!VAR:-}" ]; then
    echo -e "${RED}✗ ${VAR} is not set. See --help.${NC}" >&2
    exit 2
  fi
done

# readEnvironmentVariable only sees exported variables, so a plain assignment on the caller's line
# would resolve to empty at build time.
export "${REQUIRED_VARS[@]}"

PARAM_FILE="${REPO_ROOT}/azure/main.${ENVIRONMENT}.bicepparam"

echo -e "${BLUE}eagle-analytics → ${ENVIRONMENT} (${RESOURCE_GROUP})${NC}"

if [ "$MODE" = '--what-if' ]; then
  az deployment group what-if -g "$RESOURCE_GROUP" --subscription "$SUBSCRIPTION" \
    -f "${REPO_ROOT}/azure/main.bicep" -p "$PARAM_FILE" --only-show-errors
  exit 0
fi

NAME="analytics-${ENVIRONMENT}-$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo manual)-$(date -u +%H%M%S)"

if [ "${WHATIF_BEFORE_LIVE:-0}" = '1' ]; then
  echo -e "${BLUE}what-if…${NC}"
  az deployment group what-if -g "$RESOURCE_GROUP" --subscription "$SUBSCRIPTION" \
    -f "${REPO_ROOT}/azure/main.bicep" -p "$PARAM_FILE" --only-show-errors
fi

echo -e "${BLUE}Deploying ${NAME}…${NC}"
STATE="$(az deployment group create -g "$RESOURCE_GROUP" --subscription "$SUBSCRIPTION" \
  -f "${REPO_ROOT}/azure/main.bicep" -p "$PARAM_FILE" \
  -n "$NAME" --only-show-errors --query "properties.provisioningState" -o tsv)"
echo "$STATE"
[ "$STATE" = 'Succeeded' ] || exit 1

echo -e "${GREEN}✓ done. Copy eventsDcrEndpoint and eventsDcrImmutableId from the deployment outputs${NC}"
echo -e "${GREEN}  into the eagle-demi audit writer settings — a Direct DCR's endpoint is assigned at${NC}"
echo -e "${GREEN}  create time and cannot be composed from the name.${NC}"
