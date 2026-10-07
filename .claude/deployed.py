"""Which commit's server code is live on Cloud Run?

    python .claude/deployed.py            # the live fingerprint, and the commit it matches
    python .claude/deployed.py <commit>   # is <commit> what is live?

The server answers GET /version with a fingerprint of its own functions/*.py
(functions/main.py `_code_fingerprint`). The same fingerprint is worked out
here from the repo for recent commits, so a deploy can be confirmed without
the Cloud console (which needs Jonah's sign-in).
"""

import hashlib
import json
import subprocess
import sys
import urllib.request

URL = "https://yd-claude-147632184660.us-central1.run.app/version"


def git(*args, text=True):
    return subprocess.run(["git", *args], capture_output=True, text=text, check=True).stdout


def fingerprint(commit):
    paths = [p for p in git("ls-tree", "--name-only", commit, "functions/").split() if p.endswith(".py")]
    h = hashlib.sha1()
    for path in sorted(paths, key=lambda p: p.split("/")[-1]):
        data = git("show", "%s:%s" % (commit, path), text=False).replace(b"\r\n", b"\n")
        h.update(path.split("/")[-1].encode() + b"\0" + data + b"\0")
    return h.hexdigest()[:12]


def main():
    live = json.load(urllib.request.urlopen(URL, timeout=20))
    print("live:", live)
    if len(sys.argv) > 1:
        want = fingerprint(sys.argv[1])
        print(sys.argv[1], "->", want, "LIVE" if want == live.get("code") else "NOT live")
        return
    # The newest commit whose server code matches what is running.
    for c in git("log", "--format=%h", "-n", "40", "--", "functions/").split():
        if fingerprint(c) == live.get("code"):
            later = git("log", "--format=%h %s", c + "..HEAD", "--", "functions/").strip()
            print("live code = commit", c, "(newer server changes not live yet:\n" + later + ")" if later else "(the newest)")
            return
    print("live code matches none of the last 40 server commits")


if __name__ == "__main__":
    main()
