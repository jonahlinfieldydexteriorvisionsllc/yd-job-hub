#!/bin/bash
# Publish one rules file through the Firebase Rules API, then read it back:
#   bash publish_rules.sh <file> <release>
#   e.g. firestore.rules cloud.firestore
#        storage.rules   firebase.storage/yd-job-hub.firebasestorage.app
#
# The GitHub twin of ~/pubrules.sh and .claude/pubstorage.sh (Cloud Shell):
# compile the file as a new ruleset (a file that doesn't compile stops here,
# with what is live untouched), point the release at it, and check the live
# ruleset is byte for byte this file (length + CRC32).
set -euo pipefail
FILE="${1:?usage: publish_rules.sh <file> <release>}"
REL_ID="${2:?usage: publish_rules.sh <file> <release>}"
P=yd-job-hub
API=https://firebaserules.googleapis.com/v1
T="$(gcloud auth print-access-token)"
H=(-H "Authorization: Bearer $T" -H "Content-Type: application/json" -H "x-goog-user-project: $P")

BODY="$(python3 -c 'import json,sys; print(json.dumps({"source":{"files":[{"name":sys.argv[1],"content":open(sys.argv[1]).read()}]}}))' "$FILE")"
RS="$(curl -sS -X POST "${H[@]}" "$API/projects/$P/rulesets" -d "$BODY")"
NAME="$(printf '%s' "$RS" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("name",""))')"
if [ -z "$NAME" ]; then echo "Ruleset NOT created (nothing changed live):"; echo "$RS"; exit 1; fi
echo "ruleset $NAME"

REL="projects/$P/releases/$REL_ID"
OUT="$(curl -sS -X PATCH "${H[@]}" "$API/$REL" -d "{\"release\":{\"name\":\"$REL\",\"rulesetName\":\"$NAME\"}}")"
if ! printf '%s' "$OUT" | grep -q "$NAME"; then
  OUT="$(curl -sS -X POST "${H[@]}" "$API/projects/$P/releases" -d "{\"name\":\"$REL\",\"rulesetName\":\"$NAME\"}")"
fi
printf '%s' "$OUT" | grep -q "$NAME" || { echo "Release NOT updated:"; echo "$OUT"; exit 1; }

LIVE_RS="$(curl -sS "${H[@]}" "$API/$REL" | python3 -c 'import json,sys; print(json.load(sys.stdin)["rulesetName"])')"
curl -sS "${H[@]}" "$API/$LIVE_RS" | python3 -c '
import json, sys, zlib
live = json.load(sys.stdin)["source"]["files"][0]["content"]
mine = open(sys.argv[1]).read()
print(sys.argv[1], "LIVE", len(live), "chars, CRC32", zlib.crc32(live.encode()))
print(sys.argv[1], "repo", len(mine), "chars, CRC32", zlib.crc32(mine.encode()))
sys.exit(0 if live == mine else "live rules do not match the file")' "$FILE"
