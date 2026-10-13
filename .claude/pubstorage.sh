#!/bin/bash
# Publish storage.rules (job photos) from a commit, in Cloud Shell:
#   bash pubstorage.sh <commit>
#
# The Cloud Storage twin of ~/pubrules.sh: fetches that commit's
# storage.rules from GitHub, compiles it as a new ruleset, points the
# bucket's release at it, then reads it back (length + CRC32) so a
# half-published file can't go unnoticed.
#
# storage.rules looks people up in Firestore (users/{uid}), which the
# Storage service agent may do only with the "Firebase Rules Firestore
# Service Agent" role -- granted here once (the Firebase console does the
# same the first time such rules are published there).
set -euo pipefail
C="${1:?usage: bash pubstorage.sh <commit>}"
P=yd-job-hub
N=147632184660
B=yd-job-hub.firebasestorage.app
API=https://firebaserules.googleapis.com/v1
T="$(gcloud auth print-access-token)"
H=(-H "Authorization: Bearer $T" -H "Content-Type: application/json" -H "x-goog-user-project: $P")

SRC="$(curl -fsSL "https://raw.githubusercontent.com/jonahlinfieldydexteriorvisionsllc/yd-job-hub/$C/storage.rules")"
BODY="$(printf '%s' "$SRC" | python3 -c 'import json,sys; print(json.dumps({"source":{"files":[{"name":"storage.rules","content":sys.stdin.read()}]}}))')"
RS="$(curl -sS -X POST "${H[@]}" "$API/projects/$P/rulesets" -d "$BODY")"
NAME="$(printf '%s' "$RS" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("name",""))')"
if [ -z "$NAME" ]; then echo "Ruleset NOT created:"; echo "$RS"; exit 1; fi
echo "ruleset $NAME"

REL="projects/$P/releases/firebase.storage/$B"
OUT="$(curl -sS -X PATCH "${H[@]}" "$API/$REL" -d "{\"release\":{\"name\":\"$REL\",\"rulesetName\":\"$NAME\"}}")"
if ! printf '%s' "$OUT" | grep -q "\"rulesetName\": \"$NAME\""; then
  OUT="$(curl -sS -X POST "${H[@]}" "$API/projects/$P/releases" -d "{\"name\":\"$REL\",\"rulesetName\":\"$NAME\"}")"
fi
printf '%s' "$OUT" | grep -q "$NAME" || { echo "Release NOT updated:"; echo "$OUT"; exit 1; }

gcloud projects add-iam-policy-binding "$P" \
  --member="serviceAccount:service-$N@gcp-sa-firebasestorage.iam.gserviceaccount.com" \
  --role="roles/firebaserules.firestoreServiceAgent" --condition=None --quiet >/dev/null \
  && echo "storage may read users/ for the rules"

LIVE="$(curl -sS "${H[@]}" "$API/$(curl -sS "${H[@]}" "$API/$REL" | python3 -c 'import json,sys; print(json.load(sys.stdin)["rulesetName"])')")"
printf '%s' "$LIVE" | python3 -c '
import json, sys, zlib
src = json.load(sys.stdin)["source"]["files"][0]["content"]
print("storage rules LIVE", len(src), "chars, CRC32", zlib.crc32(src.encode()))'
printf '%s' "$SRC" | python3 -c '
import sys, zlib
src = sys.stdin.read()
print("from GitHub       ", len(src), "chars, CRC32", zlib.crc32(src.encode()))'
