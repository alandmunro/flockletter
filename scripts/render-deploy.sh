#!/usr/bin/env bash
# Deploy an exact Git commit to one Render service and wait for the
# terminal result. The API key is read only from the environment and is never
# printed. Usage: RENDER_API_KEY=... render-deploy.sh SERVICE_ID SHA [TIMEOUT]
set -euo pipefail

service_id="${1:?service id is required}"
commit_sha="${2:?commit sha is required}"
timeout_seconds="${3:-1800}"
: "${RENDER_API_KEY:?RENDER_API_KEY must be set}"

case "${service_id}" in srv-*) ;; *) echo "invalid Render service id" >&2; exit 2 ;; esac
if [[ ! "${commit_sha}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "commit must be a full lowercase SHA" >&2
  exit 2
fi
if [[ ! "${timeout_seconds}" =~ ^[0-9]+$ ]] || [ "${timeout_seconds}" -lt 60 ]; then
  echo "timeout must be at least 60 seconds" >&2
  exit 2
fi

api="https://api.render.com/v1"
response_file="$(mktemp)"
trap 'rm -f "${response_file}"' EXIT
body="$(jq -nc --arg commit "${commit_sha}" '{commitId:$commit,clearCache:"do_not_clear"}')"

http_status="$(
  curl -sS --max-time 60 -o "${response_file}" -w '%{http_code}' \
    -X POST "${api}/services/${service_id}/deploys" \
    -H "Authorization: Bearer ${RENDER_API_KEY}" \
    -H "Content-Type: application/json" \
    --data "${body}"
)"
if [[ ! "${http_status}" =~ ^2 ]]; then
  message="$(jq -r '.message // "Render refused the deploy"' "${response_file}" 2>/dev/null || true)"
  echo "${message} (HTTP ${http_status})" >&2
  exit 1
fi

deploy_id="$(jq -r '.id // empty' "${response_file}")"
if [ -z "${deploy_id}" ]; then
  echo "Render returned no deploy id" >&2
  exit 1
fi
echo "service=${service_id} deploy=${deploy_id} commit=${commit_sha}"

deadline=$(( $(date +%s) + timeout_seconds ))
last_status=""
while [ "$(date +%s)" -lt "${deadline}" ]; do
  status="$(
    curl -fsS --max-time 30 "${api}/services/${service_id}/deploys/${deploy_id}" \
      -H "Authorization: Bearer ${RENDER_API_KEY}" \
    | jq -r '.status // empty'
  )" || status=""
  if [ -n "${status}" ] && [ "${status}" != "${last_status}" ]; then
    echo "status=${status}"
    last_status="${status}"
  fi
  case "${status}" in
    live) exit 0 ;;
    build_failed|update_failed|pre_deploy_failed|canceled|deactivated)
      echo "deploy ${deploy_id} ended in ${status}" >&2
      exit 1
      ;;
    ""|created|queued|build_in_progress|update_in_progress|pre_deploy_in_progress)
      sleep 10
      ;;
    *)
      echo "deploy ${deploy_id} returned unknown status ${status}" >&2
      exit 1
      ;;
  esac
done

echo "deploy ${deploy_id} timed out in status ${last_status:-unknown}" >&2
exit 1
