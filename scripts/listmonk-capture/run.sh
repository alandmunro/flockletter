#!/usr/bin/env bash
# Run against a local Docker daemon. Only synthetic fixture data is created.
set -euo pipefail

fixture_dir="$(cd "$(dirname "$0")" && pwd)"
if [[ -n "${DOCKER_CONTEXT:-}" || -z "${DOCKER_HOST:-}" ]]; then
  docker_endpoint="$(docker context inspect "$(docker context show)" --format '{{.Endpoints.docker.Host}}')"
else
  docker_endpoint="$DOCKER_HOST"
fi
if [[ "$docker_endpoint" != unix://* ]]; then
  echo 'Select a local Unix-socket Docker context to run the fixture.' >&2
  exit 1
fi

listmonk='listmonk/listmonk:v6.2.0@sha256:f535d59e14991337a9f2d570273685378ae86b0d7698c3e00da444e3bc205286'
postgres='postgres:18-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873'
node_image='node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d'

random_value() { node -p "require('node:crypto').randomBytes(20).toString('hex')"; }
prefix="fl-listmonk-$(random_value)"
network_id=
function cleanup() {
  # Labels select only containers this invocation created, including an interrupted one-shot run.
  local id
  for id in $(docker ps --all --quiet --filter "label=flockletter.fixture=$prefix"); do
    docker rm --force --volumes "$id" >/dev/null || true
  done
  if [[ -n "$network_id" ]]; then
    docker network rm "$network_id" >/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Generate both parts using the same Flockletter renderer used by the reviewed capture.
FLOCKLETTER_STUDIO_FIXTURE="$(node --import tsx "$fixture_dir/studio-fixture.ts" --column-images)"
export FLOCKLETTER_STUDIO_FIXTURE
network_id="$(docker network create --internal --label "flockletter.fixture=$prefix" "$prefix")"
[[ "$(docker network inspect --format '{{.Internal}}' "$network_id")" = true ]]
common=(--network "$network_id" --label "flockletter.fixture=$prefix" --security-opt no-new-privileges)
export POSTGRES_PASSWORD="$(random_value)"
export LISTMONK_db__password="$POSTGRES_PASSWORD"
export LISTMONK_ADMIN_PASSWORD="$(random_value)"
export FIXTURE_CAPTURE_SECRET="$(random_value)"
database="$(docker run -d "${common[@]}" --network-alias database --tmpfs /var/lib/postgresql:rw,size=256m \
  -e POSTGRES_DB=engine_fixture -e POSTGRES_USER=fixture -e POSTGRES_PASSWORD "$postgres")"
for _ in {1..60}; do
  if docker exec "$database" pg_isready -q -h 127.0.0.1 -U fixture -d engine_fixture; then break; fi
  sleep 1
done
docker exec "$database" pg_isready -q -h 127.0.0.1 -U fixture -d engine_fixture

engine_args=("${common[@]}" --user 65534:65534 --read-only --tmpfs /tmp:rw,size=16m --cap-drop ALL
  --entrypoint /listmonk/listmonk -e LISTMONK_app__address=0.0.0.0:9000 -e LISTMONK_db__host=database
  -e LISTMONK_db__port=5432 -e LISTMONK_db__user=fixture -e LISTMONK_db__database=engine_fixture
  -e LISTMONK_db__ssl_mode=disable -e LISTMONK_db__password)
docker run --rm "${engine_args[@]}" -e LISTMONK_ADMIN_USER=fixture-owner -e LISTMONK_ADMIN_PASSWORD \
  "$listmonk" --install --yes --config ''

# Replace upstream sample SMTP settings before starting any workers.
docker exec -i -e FIXTURE_CAPTURE_SECRET "$database" psql --quiet --no-psqlrc --set=ON_ERROR_STOP=1 \
  --username=fixture --dbname=engine_fixture <<'SQL'
\getenv messenger_password FIXTURE_CAPTURE_SECRET
UPDATE settings SET value='[]' WHERE key IN ('smtp','app.notify_emails');
UPDATE settings SET value='false' WHERE key IN ('app.check_updates','app.send_optin_confirmation','privacy.individual_tracking');
UPDATE settings SET value='true' WHERE key='privacy.disable_tracking';
UPDATE settings SET value=jsonb_build_array(jsonb_build_object(
  'enabled',true,'name','fixture','root_url','http://capture:8080/message','username','fixture',
  'password',:'messenger_password','max_conns',1,'max_msg_retries',0,'timeout','3s'
)) WHERE key='messengers';
DO $$
BEGIN
  IF (SELECT count(*) FROM settings WHERE
    (key='smtp' AND value='[]'::jsonb) OR
    (key='app.send_optin_confirmation' AND value='false'::jsonb) OR
    (key='messengers' AND jsonb_array_length(value)=1 AND value->0->>'root_url'='http://capture:8080/message')) <> 3
  THEN RAISE EXCEPTION 'Fixture delivery settings were not applied'; END IF;
END $$;
SQL
engine="$(docker run -d "${engine_args[@]}" --network-alias engine "$listmonk" --config '')"
[[ -z "$(docker port "$database")" && -z "$(docker port "$engine")" ]]
docker run --rm -i "${common[@]}" --network-alias capture --user node --cap-drop ALL --read-only \
  -e LISTMONK_ADMIN_PASSWORD -e FIXTURE_CAPTURE_SECRET -e FLOCKLETTER_STUDIO_FIXTURE "$node_image" node --input-type=module - < "$fixture_dir/probe.mjs"
