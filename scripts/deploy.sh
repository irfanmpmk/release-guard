#!/usr/bin/env bash
# Validated release with automatic rollback, on a single Docker host.
#
#   scripts/deploy.sh <image> [env-file]
#
# 1. Start the new image as a candidate on CANDIDATE_PORT, next to the live one.
# 2. Wait for /ready, then run the smoke tests against it, including a check that
#    it reports the commit baked into the image.
# 3. Only if that passes: replace the live container and run the smoke tests again.
# 4. If the candidate fails, the live release is left untouched. If the release
#    fails after the switch, the previous image is restored.
#
# Needs docker, curl, and node with this repo's dependencies installed (for the
# smoke tests). Data lives in memory in this demo, so a switch starts empty;
# a real deployment would point DB_PATH at a volume.
set -euo pipefail

IMAGE=${1:?usage: scripts/deploy.sh <image> [env-file]}
ENV_FILE=${2:-}
NAME=${APP_NAME:-bookings-api}
LIVE_PORT=${LIVE_PORT:-3000}
CANDIDATE_PORT=${CANDIDATE_PORT:-3001}

log() { echo "[deploy] $*"; }

expected_commit=$(docker image inspect "$IMAGE" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^GIT_SHA=//p')
previous_image=$(docker inspect --format '{{.Config.Image}}' "$NAME" 2>/dev/null || true)

start() { # name port image [env-file]
  local args=(-d --name "$1" -p "$2:3000" --restart unless-stopped)
  [[ -n ${4:-} ]] && args+=(--env-file "$4")
  docker run "${args[@]}" "$3" >/dev/null
}

wait_ready() {
  for _ in $(seq 1 30); do
    curl -fsS "http://localhost:$1/ready" >/dev/null 2>&1 && return 0
    sleep 1
  done
  log "no /ready response on :$1 after 30s"
  return 1
}

smoke() {
  BASE_URL="http://localhost:$1" EXPECTED_COMMIT="$expected_commit" npx playwright test --reporter=line
}

# ---- 1-2. Validate the candidate beside the live release
docker rm -f "$NAME-candidate" >/dev/null 2>&1 || true
log "starting candidate $IMAGE (commit ${expected_commit:-unknown}) on :$CANDIDATE_PORT"
start "$NAME-candidate" "$CANDIDATE_PORT" "$IMAGE" "$ENV_FILE"

if ! { wait_ready "$CANDIDATE_PORT" && smoke "$CANDIDATE_PORT"; }; then
  log "candidate FAILED validation; live release unchanged (${previous_image:-none running})"
  docker logs --tail 30 "$NAME-candidate" 2>&1 || true
  docker rm -f "$NAME-candidate" >/dev/null
  exit 1
fi
docker rm -f "$NAME-candidate" >/dev/null
log "candidate passed"

# ---- 3. Switch and verify again
docker rm -f "$NAME" >/dev/null 2>&1 || true
start "$NAME" "$LIVE_PORT" "$IMAGE" "$ENV_FILE"
if wait_ready "$LIVE_PORT" && smoke "$LIVE_PORT"; then
  log "release $IMAGE is live on :$LIVE_PORT"
  exit 0
fi

# ---- 4. Roll back
log "post-switch verification FAILED; rolling back"
docker rm -f "$NAME" >/dev/null 2>&1 || true
if [[ -n $previous_image ]]; then
  start "$NAME" "$LIVE_PORT" "$previous_image"
  wait_ready "$LIVE_PORT" && log "rolled back to $previous_image"
else
  log "no previous release to roll back to"
fi
exit 1
