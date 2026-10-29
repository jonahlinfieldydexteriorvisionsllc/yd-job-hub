#!/bin/bash
# Put a new Claude (Anthropic) API key on the Job Hub server, in Cloud Shell:
#   bash claudekey.sh
#
# Anthropic keys can expire (the first one ran out 31 Oct 2026). Make the new
# one on platform.claude.com/settings/keys with Expiration "Never" and Workspace
# "Default" -- a key tied to no workspace is refused unless every call names
# one, and the server's calls don't. The server
# (Cloud Run yd-claude) reads the key as ANTHROPIC_API_KEY from Secret Manager.
# This asks for the new key without showing it, checks it with Anthropic first
# (listing models costs nothing), saves it as a new version of that same
# secret, and rolls the server onto it. A key Anthropic refuses changes nothing.
set -euo pipefail
P=yd-job-hub
R=us-central1
S=yd-claude
URL=https://yd-claude-147632184660.us-central1.run.app

# Which secret the server reads the key from -- looked up, not assumed.
SEC="$(gcloud run services describe "$S" --region "$R" --project "$P" --format=json | python3 -c '
import json, sys
d = json.load(sys.stdin)
for c in d["spec"]["template"]["spec"]["containers"]:
    for e in c.get("env", []):
        if e.get("name") == "ANTHROPIC_API_KEY":
            print(((e.get("valueFrom") or {}).get("secretKeyRef") or {}).get("name", ""))
')"
if [ -z "$SEC" ]; then
  echo "The server does not read ANTHROPIC_API_KEY from Secret Manager -- nothing changed. Tell Claude."
  exit 1
fi
echo "The server reads the key from secret: $SEC"

read -rsp "Paste the NEW Claude key (it won't show on screen), then press Enter: " K; echo
K="$(printf '%s' "$K" | tr -d '[:space:]')"
case "$K" in
  sk-ant-*) ;;
  *) echo "That doesn't look like a Claude key (they start with sk-ant-). Nothing changed."; exit 1 ;;
esac

# The key reaches curl on stdin, never on its command line.
CODE="$(printf 'x-api-key: %s\nanthropic-version: 2023-06-01\n' "$K" \
  | curl -sS -o /dev/null -w '%{http_code}' -H @- https://api.anthropic.com/v1/models || true)"
case "$CODE" in
  200) ;;
  400) echo "Anthropic refused that key (HTTP 400) -- most likely it isn't tied to a workspace."
       echo "Make it again with Workspace set to Default, then re-run. Nothing changed."; exit 1 ;;
  401) echo "Anthropic doesn't know that key (HTTP 401) -- copied wrong, or deleted. Copy it again and re-run. Nothing changed."; exit 1 ;;
  *)   echo "Anthropic refused that key (HTTP $CODE). Nothing changed -- copy the key again and re-run."; exit 1 ;;
esac
echo "Anthropic accepts the new key."

printf '%s' "$K" | gcloud secrets versions add "$SEC" --project "$P" --data-file=- >/dev/null
unset K
echo "Saved as the newest version of $SEC."

# A new revision reads the secret when it starts. Pointing it at :latest means
# the next swap only has to add a version and roll a revision, like this one.
gcloud run services update "$S" --region "$R" --project "$P" \
  --update-secrets "ANTHROPIC_API_KEY=$SEC:latest" --quiet
sleep 5
curl -fsS "$URL/version" && echo
echo "Done -- the server now uses the new key."
