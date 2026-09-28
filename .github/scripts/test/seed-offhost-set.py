#!/usr/bin/env python3
"""TEST ONLY — seeds a three-object off-host set into the fake provider
(fake-gcs.py) so the auditor harness can exercise every validation rule.

    seed-offhost-set.py EP SET [key=value ...]

Options (defaults produce a fully consistent, fully observed set):
  prefix=dev/postgres  kind=daily|monthly  observation=create-responses-validated|remote-audit-required
  gen=<base generation>  t0=<RFC3339 dump time>  dt_sidecar=<seconds>  dt_manifest=<seconds>
  null_generations=1        manifest claims no observed generation (audit-required case)
  no_manifest=1 no_sidecar=1 no_dump=1
  bad_size=1 bad_md5=1 bad_sha256=1 missing_sha256=1 bad_generation=1 bad_key=1
  bad_schema=1 incomplete=1 wrong_slot=1 foreign_manifest=1 manifest_earlier=1
  duplicate_live=1          adds a second live generation of the dump (versions listing)
  derived_from=<set>        monthly manifests
"""
import base64
import hashlib
import json
import sys
import urllib.request

ep, setname = sys.argv[1], sys.argv[2]
opt = dict(a.split("=", 1) for a in sys.argv[3:])
prefix = opt.get("prefix", "dev/postgres"); kind = opt.get("kind", "daily")
observation = opt.get("observation", "create-responses-validated")
gen = int(opt.get("gen", "1700000000100000"))
t0 = opt.get("t0", "2026-09-28T03:30:10.000Z")


def shift(ts, secs):
    import datetime, calendar
    base, frac = ts[:-1].split(".") if "." in ts else (ts[:-1], "000")
    dt = datetime.datetime.strptime(base, "%Y-%m-%dT%H:%M:%S")
    e = calendar.timegm(dt.timetuple()) + int(secs)
    return datetime.datetime.utcfromtimestamp(e).strftime("%Y-%m-%dT%H:%M:%S") + "." + frac + "Z"


dt_s = int(opt.get("dt_sidecar", "1")); dt_m = int(opt.get("dt_manifest", "2"))
if opt.get("manifest_earlier"):
    dt_m = -5
slot = setname[len("leadcapture-"):len("leadcapture-") + 13]   # YYYYMMDD-HHMM of the stamp …
import datetime, calendar
stamp = datetime.datetime.strptime(setname[len("leadcapture-"):-len(".sql.gz")], "%Y%m%d-%H%M%S")
e = calendar.timegm(stamp.timetuple()); idx = (e - (3 * 3600 + 15 * 60)) // 86400
slot = datetime.datetime.utcfromtimestamp(idx * 86400 + 3 * 3600 + 15 * 60).strftime("%Y%m%d-%H%M")
if opt.get("wrong_slot"):
    slot = "20200101-0315"

dump = ("-- PostgreSQL database dump\n" + "row-%s\n" % setname * 40 + "-- PostgreSQL database dump complete\n").encode()
sha = hashlib.sha256(dump).hexdigest()
sidecar = ("%s  %s\n" % (sha, setname)).encode()


def md5(b):
    return base64.b64encode(hashlib.md5(b).digest()).decode()


base = "%s/%s/%s" % (prefix, kind, setname)
dkey, skey, mkey = base, base + ".sha256", base + ".manifest.json"
dump_gen, sidecar_gen, manifest_gen = gen, gen + 1, gen + 2
m_dump_gen = None if opt.get("null_generations") else str(dump_gen)
m_sidecar_gen = None if opt.get("null_generations") else str(sidecar_gen)
if opt.get("bad_generation"):
    m_dump_gen = str(dump_gen + 77)
manifest = {
    "manifest_schema": "lcp-offhost-manifest/2" if not opt.get("bad_schema") else "lcp-offhost-manifest/1",
    "environment": "hosted-dev", "region": "me-central2", "set": setname, "slot": slot, "kind": kind,
    "derived_from": opt.get("derived_from"), "observation": observation,
    "dump": {"key": dkey if not opt.get("bad_key") else dkey + ".other", "size": len(dump) + (1 if opt.get("bad_size") else 0),
             "sha256": sha if not opt.get("bad_sha256") else "0" * 64, "md5_expected": md5(dump) if not opt.get("bad_md5") else md5(b"x"),
             "generation": m_dump_gen, "md5_observed": md5(dump) if m_dump_gen else None, "crc32c_observed": None},
    "sidecar": {"key": skey, "size": len(sidecar), "md5_expected": md5(sidecar), "generation": m_sidecar_gen,
                "md5_observed": md5(sidecar) if m_sidecar_gen else None, "crc32c_observed": None},
    "uncompressed_sensitive_data": "none", "uploaded_utc": shift(t0, dt_m), "uploader": "seed-offhost-set.py", "status": "complete",
}
mbody = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode()
mmeta = {
    "schema": manifest["manifest_schema"], "status": "incomplete" if opt.get("incomplete") else "complete", "kind": kind, "slot": slot,
    "set": setname, "env": "hosted-dev", "observation": observation,
    "dump_key": manifest["dump"]["key"], "dump_size": str(manifest["dump"]["size"]), "dump_sha256": manifest["dump"]["sha256"],
    "dump_md5_expected": manifest["dump"]["md5_expected"], "dump_generation": m_dump_gen if m_dump_gen else "null",
    "sidecar_key": skey, "sidecar_size": str(len(sidecar)), "sidecar_md5_expected": md5(sidecar),
    "sidecar_generation": m_sidecar_gen if m_sidecar_gen else "null",
    "manifest_sha256": hashlib.sha256(mbody).hexdigest(), "derived_from": opt.get("derived_from", ""),
}
if opt.get("foreign_manifest"):
    mmeta = {"status": "complete", "note": "foreign"}
    mbody = b"{}"
obj_meta = {"schema": "lcp-offhost-object/1", "sha256": sha, "slot": slot, "set": setname, "kind": kind, "env": "hosted-dev"}
if opt.get("missing_sha256"):
    obj_meta = {k: v for k, v in obj_meta.items() if k != "sha256"}


def seed(key, content, meta, generation, tc, noncurrent=False, time_deleted="now"):
    payload = {"key": key, "content_b64": base64.b64encode(content).decode(), "metadata": meta, "generation": generation, "timeCreated": tc}
    if noncurrent:
        payload["noncurrent"] = True
        payload["timeDeleted"] = time_deleted
    req = urllib.request.Request(ep + "/__control/seed", data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
    urllib.request.urlopen(req).read()


if not opt.get("no_dump"):
    seed(dkey, dump, obj_meta, dump_gen, t0)
if not opt.get("no_sidecar"):
    seed(skey, sidecar, obj_meta, sidecar_gen, shift(t0, dt_s))
if not opt.get("no_manifest"):
    seed(mkey, mbody, mmeta, manifest_gen, shift(t0, dt_m))
if opt.get("duplicate_live"):
    seed(dkey, dump, obj_meta, dump_gen + 5000, shift(t0, 30), noncurrent=True, time_deleted=None)
print("seeded %s (%s, %s)" % (setname, kind, observation))
