# Off-host backup — Workload Identity Federation trust contract (B23 G-6D, Correction 1)

This is the **intended** trust configuration for the keyless off-host backup
workflow. Nothing here is created by the repository; Gate 1 configures it in
the dedicated GCP project and GitHub, and `.github/scripts/offhost-wif-policy.py`
evaluates the same rule deterministically in the harness. No service-account
key exists anywhere in this design.

## Identity source

| Item | Value |
|---|---|
| Issuer | `https://token.actions.githubusercontent.com` |
| Repository | `Delowar01/Exhibition-Lead-Pro` |
| `repository_id` | `1275185839` |
| `repository_owner_id` | `64171170` |
| Ref | `refs/heads/export-ready` (the default branch; scheduled workflows run only from it) |
| `workflow_ref` | `Delowar01/Exhibition-Lead-Pro/.github/workflows/backup-offhost.yml@refs/heads/export-ready` |
| Events | `schedule`, `workflow_dispatch` |
| Environments | `offhost-upload` (job `upload`), `offhost-audit` (job `audit`) |
| Subject | `repo:Delowar01/Exhibition-Lead-Pro:environment:<environment>` (the job references an environment, so GitHub emits the environment form of `sub`) |

`job_workflow_ref` is deliberately **not** used: this is not a reusable workflow.

## Provider (one OIDC provider in pool `lcp-github`)

Attribute mapping (exactly these):

```
google.subject=assertion.sub
attribute.repository_id=assertion.repository_id
attribute.repository_owner_id=assertion.repository_owner_id
attribute.repository=assertion.repository
attribute.ref=assertion.ref
attribute.workflow_ref=assertion.workflow_ref
attribute.event_name=assertion.event_name
attribute.environment=assertion.environment
```

Attribute condition (CEL, verbatim):

```
assertion.repository_id == "1275185839" && assertion.repository_owner_id == "64171170" && assertion.repository == "Delowar01/Exhibition-Lead-Pro" && assertion.ref == "refs/heads/export-ready" && assertion.workflow_ref == "Delowar01/Exhibition-Lead-Pro/.github/workflows/backup-offhost.yml@refs/heads/export-ready" && assertion.event_name in ["schedule", "workflow_dispatch"] && assertion.environment in ["offhost-upload", "offhost-audit"]
```

Allowed audience: the provider's own resource name
(`//iam.googleapis.com/projects/<project-number>/locations/global/workloadIdentityPools/lcp-github/providers/github-oidc`),
stored in GitHub as the secrets `OFFHOST_WIF_AUDIENCE_UPLOAD` and
`OFFHOST_WIF_AUDIENCE_AUDIT` (masked, non-secret values).

Rejected by construction: pull requests (no environment form of `sub`, event
`pull_request`), pushes, other branches, other workflows, forks and other
repositories, other owners, and any job that does not reference one of the two
environments.

## IAM boundaries (direct principal-set bindings; impersonation only as tested fallback)

| Principal set | Authority | Must be denied |
|---|---|---|
| `principalSet://iam.googleapis.com/projects/<project-number>/locations/global/workloadIdentityPools/lcp-github/attribute.environment/offhost-upload` | `roles/storage.objectCreator` on the backup bucket (create-only) | list, get, download, update, delete, overwrite; any auditor authority |
| `…/attribute.environment/offhost-audit` | custom role `lcpBackupAuditor` = `storage.objects.list` only | get, download, create, update, delete, IAM, lifecycle, retention; any uploader authority |

Cross-environment access is denied because each binding names a different
`attribute.environment` value; the harness proves the intended rule rejects a
token from one environment for the other role.

## GitHub Environments

* `offhost-upload` and `offhost-audit` must exist and be **restricted to the
  branch `export-ready`** (deployment branch policy).
* **No required human reviewers**: scheduled runs must stay unattended. Wait
  timers are not used.
* Environment secrets are not required; the audience/bucket values live as
  repository secrets (`OFFHOST_BUCKET`, `OFFHOST_WIF_AUDIENCE_UPLOAD`,
  `OFFHOST_WIF_AUDIENCE_AUDIT`) next to the existing `VPS_*` SSH secrets.

## Credential lifetime

Every GitHub-derived credential is treated as a **five-minute** credential: the
upload job requests its token immediately before SSH, bounds the SSH session
to 240 s, and the uploader refuses to start an object create outside its
credential window; the audit job requests a separate token and finishes in
seconds. Nothing is cached.
