"""Signed papers on a job (signatures.js): a change order, a sign-off when
the work is finished, or anything else the customer signs on the iPad.

Jonah (15 Oct 2026): change orders and sign-offs signed inside Job Hub, the
PDF saved on the job. The phone makes the PDF and keeps it in Cloud Storage
(jobDocs/{jobId}/{uid}/{docId}.pdf); its record is jobDocs/{docId}.

Here: "Email a copy" -- his tap, never by itself -- sends the signed PDF to
the job's customer from the owner's Gmail, the way the summaries go out.
(The change order's price onto QuickBooks is quickbooks.add_change_order.)
"""

import base64
import re

import requests

import digest as dg

BUCKET = "yd-job-hub.firebasestorage.app"
KIND_WORDS = {"change": "change order", "signoff": "sign-off", "other": "signed paper"}
EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _pdf(doc):
    if doc.get("pending") or not doc.get("path"):
        raise RuntimeError("The signed PDF is still on the phone it was signed on — it goes up when that phone has signal")
    from firebase_admin import storage
    return storage.bucket(BUCKET).blob(doc["path"]).download_as_bytes()


def email_copy(db, doc_id, who=""):
    """The signed PDF to the job's customer. Returns {ok, at, to}; the paper
    notes it (emailed) so the screen can say it went, and when."""
    from email.mime.application import MIMEApplication
    from email.mime.multipart import MIMEMultipart
    from email.mime.text import MIMEText
    if not re.fullmatch(r"sg[a-z0-9]+", str(doc_id or "")):
        raise RuntimeError("Which signed paper?")
    ref = db.collection("jobDocs").document(doc_id)
    doc = ref.get().to_dict()
    if not doc:
        raise RuntimeError("No such signed paper")
    job = db.collection("jobs").document(str(doc.get("jobId") or "")).get().to_dict() or {}
    to = str(job.get("email") or "").strip()
    if not EMAIL.match(to):
        raise RuntimeError("The job has no customer email — add it on the Job tab first")
    raw = _pdf(doc)
    kind = KIND_WORDS.get(doc.get("kind"), "signed paper")
    first = (str(job.get("firstName") or "").strip() or str(doc.get("signedName") or "").strip().split(" ")[0]
             or "there")
    day = str(doc.get("signedAt") or "")[:10]
    msg = MIMEMultipart("mixed")
    msg["To"] = to
    msg["From"] = dg.OWNER_EMAIL
    msg["Subject"] = "Your signed %s — YD Exterior Visions" % kind
    text = ("Hi %s,\n\nAttached is a copy of the %s you signed%s%s, for your records.\n\n"
            "Thank you,\nYD Exterior Visions LLC\n") % (
        first, kind, (" on " + day) if day else "",
        (" (" + str(doc.get("title")).strip() + ")") if str(doc.get("title") or "").strip() else "")
    msg.attach(MIMEText(text, "plain", "utf-8"))
    part = MIMEApplication(raw, _subtype="pdf")
    part.add_header("Content-Disposition", "attachment",
                    filename=re.sub(r"[^A-Za-z0-9 ._-]+", "", "%s %s.pdf" % (kind.capitalize(), day)).strip() or "signed.pdf")
    msg.attach(part)
    resp = requests.post("https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
                         headers={"Authorization": "Bearer " + dg._gmail_access_token()},
                         json={"raw": base64.urlsafe_b64encode(msg.as_bytes()).decode()}, timeout=60)
    if resp.status_code >= 300:
        raise RuntimeError("Gmail said %d: %s" % (resp.status_code, resp.text[:200]))
    # Not the address it went to: the crew member who collected the paper can
    # read this record, and the customer's email is not theirs to see.
    out = {"ok": True, "at": dg._now().isoformat(), "by": str(who or "")[:80]}
    ref.set({"emailed": out}, merge=True)
    return out
