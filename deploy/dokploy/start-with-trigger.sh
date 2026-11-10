#!/bin/sh
set -eu

credentials="${TRIGGER_CREDENTIALS_FILE:-/run/trigger/credentials.env}"
if [ -r "$credentials" ]; then
  # shellcheck disable=SC1090
  . "$credentials"
fi
export TRIGGER_PROJECT_ID TRIGGER_SECRET_KEY
exec node server.js
