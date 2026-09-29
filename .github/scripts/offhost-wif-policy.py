#!/usr/bin/env python3
"""Lead Capture Pro — Workload Identity Federation trust contract for the off-host
backup workflow (B23 G-6D Correction 1). Documentation and a deterministic
evaluator of the INTENDED provider admission rule and IAM boundaries; it
creates nothing. The same rule is written as the provider's CEL attribute
condition in .github/wif/offhost-trust-contract.md and is what Gate 1 must
configure.

    offhost-wif-policy.py print-contract
    offhost-wif-policy.py evaluate '<claims json>' <upload|audit>

`evaluate` prints ADMIT or DENY <reason> and exits 0/1. The role names the
authority the caller wants (create-only uploader or list-only auditor); a
token admitted by the provider still gets DENY when its environment does not
match that role (cross-environment access).
"""
import json
import sys

REPOSITORY = "Delowar01/Exhibition-Lead-Pro"
REPOSITORY_ID = "1275185839"
REPOSITORY_OWNER_ID = "64171170"
REF = "refs/heads/export-ready"
WORKFLOW_REF = "Delowar01/Exhibition-Lead-Pro/.github/workflows/backup-offhost.yml@refs/heads/export-ready"
EVENTS = ("schedule", "workflow_dispatch")
ENVIRONMENTS = ("offhost-upload", "offhost-audit")
ISSUER = "https://token.actions.githubusercontent.com"

ATTRIBUTE_MAPPING = [
    "google.subject=assertion.sub",
    "attribute.repository_id=assertion.repository_id",
    "attribute.repository_owner_id=assertion.repository_owner_id",
    "attribute.repository=assertion.repository",
    "attribute.ref=assertion.ref",
    "attribute.workflow_ref=assertion.workflow_ref",
    "attribute.event_name=assertion.event_name",
    "attribute.environment=assertion.environment",
]

ATTRIBUTE_CONDITION = (
    'assertion.repository_id == "1275185839" && '
    'assertion.repository_owner_id == "64171170" && '
    'assertion.repository == "Delowar01/Exhibition-Lead-Pro" && '
    'assertion.ref == "refs/heads/export-ready" && '
    'assertion.workflow_ref == "Delowar01/Exhibition-Lead-Pro/.github/workflows/backup-offhost.yml@refs/heads/export-ready" && '
    'assertion.event_name in ["schedule", "workflow_dispatch"] && '
    'assertion.environment in ["offhost-upload", "offhost-audit"]'
)

ROLE_ENVIRONMENT = {"upload": "offhost-upload", "audit": "offhost-audit"}
ROLE_AUTHORITY = {
    "upload": "roles/storage.objectCreator on the backup bucket (create-only; no list/get/update/delete)",
    "audit": "custom role lcpBackupAuditor = storage.objects.list only",
}
PRINCIPAL_SET = "principalSet://iam.googleapis.com/projects/<project-number>/locations/global/workloadIdentityPools/lcp-github/attribute.environment/{environment}"


def admit(claims):
    """Provider admission: every required claim must be present and exact."""
    checks = [
        ("issuer", claims.get("iss") == ISSUER),
        ("repository_id", claims.get("repository_id") == REPOSITORY_ID),
        ("repository_owner_id", claims.get("repository_owner_id") == REPOSITORY_OWNER_ID),
        ("repository", claims.get("repository") == REPOSITORY),
        ("ref", claims.get("ref") == REF),
        ("workflow_ref", claims.get("workflow_ref") == WORKFLOW_REF),
        ("event_name", claims.get("event_name") in EVENTS),
        ("environment", claims.get("environment") in ENVIRONMENTS),
    ]
    for name, ok in checks:
        if not ok:
            return False, name
    expected_sub = "repo:%s:environment:%s" % (REPOSITORY, claims["environment"])
    if claims.get("sub") != expected_sub:
        return False, "sub"
    return True, "ok"


def authorize(claims, role):
    """IAM boundary: the admitted identity may use only its own environment's authority."""
    if role not in ROLE_ENVIRONMENT:
        return False, "unknown-role"
    ok, reason = admit(claims)
    if not ok:
        return False, "provider-" + reason
    if claims.get("environment") != ROLE_ENVIRONMENT[role]:
        return False, "cross-environment"
    return True, ROLE_AUTHORITY[role]


def main(argv):
    if len(argv) >= 2 and argv[1] == "print-contract":
        print(json.dumps({
            "issuer": ISSUER, "repository": REPOSITORY, "repository_id": REPOSITORY_ID,
            "repository_owner_id": REPOSITORY_OWNER_ID, "ref": REF, "workflow_ref": WORKFLOW_REF,
            "events": list(EVENTS), "environments": list(ENVIRONMENTS),
            "attribute_mapping": ATTRIBUTE_MAPPING, "attribute_condition": ATTRIBUTE_CONDITION,
            "principal_sets": {r: PRINCIPAL_SET.format(environment=e) for r, e in ROLE_ENVIRONMENT.items()},
            "authority": ROLE_AUTHORITY,
        }, indent=2, sort_keys=True))
        return 0
    if len(argv) == 4 and argv[1] == "evaluate":
        claims = json.loads(argv[2])
        ok, reason = authorize(claims, argv[3])
        print(("ADMIT " if ok else "DENY ") + reason)
        return 0 if ok else 1
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
