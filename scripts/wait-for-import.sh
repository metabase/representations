#!/usr/bin/env bash
# Usage: wait-for-import.sh TASK_ID
#
# Waits until the git sync task TASK_ID of the Metabase at $MB_URL ends, and
# exits 0 when it succeeded. Otherwise prints Metabase's last answer and exits
# 1: when the task ends with another status, or when it has not ended after
# $TIMEOUT_SECONDS (default 300). Asks every $POLL_SECONDS (default 2), with
# the API key in $API_KEY.
set -euo pipefail

TASK_ID=$1
DEADLINE=$((SECONDS + ${TIMEOUT_SECONDS:-300}))

while true; do
  # The most recent task, which is an earlier one until TASK_ID starts.
  TASK=$(curl -sf "$MB_URL/api/ee/remote-sync/current-task" -H "X-API-Key: $API_KEY" || true)
  STATUS=$(jq -r --argjson id "$TASK_ID" 'if type == "object" and .id == $id then .status else "waiting" end' \
    <<< "${TASK:-null}" 2> /dev/null || echo waiting)
  case $STATUS in
    successful)
      echo "Import $TASK_ID succeeded"
      exit 0
      ;;
    running | waiting) ;;
    *)
      echo "$TASK"
      echo "Import $TASK_ID ended with status $STATUS"
      exit 1
      ;;
  esac
  if ((SECONDS >= DEADLINE)); then
    echo "${TASK:-(no answer)}"
    echo "Import $TASK_ID did not finish in time"
    exit 1
  fi
  sleep "${POLL_SECONDS:-2}"
done
