#!/usr/bin/env python3
"""TEST ONLY — deterministic fake of the Cloud Storage JSON API and the STS
token-exchange endpoint for the off-host backup harnesses.

    python3 fake-gcs.py <port-or-0> <state-dir>

Implements: STS token exchange (POST /v1/token), IAM credentials
generateAccessToken, resumable and multipart objects.insert with
ifGenerationMatch=0 semantics (412 when a live object exists) and md5Hash
validation (400 on mismatch), resumable session status queries (308/200),
objects.list (prefix, versions, maxResults/pageToken), and 403 for every
other object operation (get, download, patch, delete) so the harness can
prove they are never attempted. Fault injection and inspection through
/__control/* — never used by the production scripts.
"""
import base64
import hashlib
import json
import os
import re
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(sys.argv[1])
STATE_DIR = sys.argv[2]
LOCK = threading.Lock()
OBJECTS = {}      # key -> {"live": resource|None, "data": bytes, "noncurrent": [resource]}
SESSIONS = {}     # upload_id -> dict
FAULTS = []       # {"match": {...}, "action": "...", "times": n}
REQLOG = []
GEN = [1700000000000000]
CLOCK = [0.0]     # offset seconds added to wall clock for timeCreated
TOKENS = set()

_CRC_TABLE = []
for _n in range(256):
    _c = _n
    for _ in range(8):
        _c = (_c >> 1) ^ 0x82F63B78 if _c & 1 else _c >> 1
    _CRC_TABLE.append(_c)


def crc32c_b64(data):
    crc = 0xFFFFFFFF
    for b in data:
        crc = _CRC_TABLE[(crc ^ b) & 0xFF] ^ (crc >> 8)
    crc ^= 0xFFFFFFFF
    return base64.b64encode(crc.to_bytes(4, "big")).decode()


def md5_b64(data):
    return base64.b64encode(hashlib.md5(data).digest()).decode()


def now_rfc3339():
    t = time.time() + CLOCK[0]
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t)) + ".%03dZ" % int((t % 1) * 1000)


def next_gen():
    GEN[0] += 1
    return GEN[0]


def make_resource(bucket, key, data, meta, gen=None, time_created=None):
    return {
        "kind": "storage#object",
        "name": key,
        "bucket": bucket,
        "generation": str(gen if gen is not None else next_gen()),
        "metageneration": "1",
        "size": str(len(data)),
        "md5Hash": md5_b64(data),
        "crc32c": crc32c_b64(data),
        "contentType": meta.get("contentType", "application/octet-stream"),
        "metadata": dict(meta.get("metadata", {})),
        "timeCreated": time_created or now_rfc3339(),
        "updated": time_created or now_rfc3339(),
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):  # silence
        pass

    # ── helpers ──────────────────────────────────────────────────────────────
    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def send(self, code, obj=None, headers=None, raw=None):
        payload = raw if raw is not None else (json.dumps(obj).encode() if obj is not None else b"")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=UTF-8")
        self.send_header("Content-Length", str(len(payload)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if payload:
            self.wfile.write(payload)

    def drop(self):
        # Close without any response: curl sees "Empty reply from server" (52).
        self.close_connection = True

    def error(self, code, message):
        self.send(code, {"error": {"code": code, "message": message}})

    def record(self, u, q, extra):
        entry = {
            "method": self.command,
            "path": u.path,
            "query": {k: v[0] for k, v in q.items()},
            "auth": "bearer" if (self.headers.get("Authorization") or "").startswith("Bearer ") else "none",
            "content_range": self.headers.get("Content-Range", ""),
            "content_type": (self.headers.get("Content-Type") or "").split(";")[0],
            "t": time.time(),
        }
        entry.update(extra)
        with LOCK:
            REQLOG.append(entry)

    def fault_for(self, u, q, name):
        with LOCK:
            for f in FAULTS:
                m = f["match"]
                if f["times"] <= 0:
                    continue
                if m.get("method") and m["method"] != self.command:
                    continue
                if m.get("path_contains") and m["path_contains"] not in u.path + "?" + u.query:
                    continue
                if m.get("name_contains") and m["name_contains"] not in (name or ""):
                    continue
                if m.get("name_not_contains") and m["name_not_contains"] in (name or ""):
                    continue
                f["times"] -= 1
                return f["action"]
        return None

    def apply_fault(self, action):
        """Returns True when the fault fully handled the response."""
        if action is None:
            return False
        if action.startswith("status:"):
            code = int(action.split(":")[1])
            self.error(code, "injected fault %d" % code)
            return True
        if action == "drop":
            self.drop()
            return True
        if action.startswith("hang:"):
            time.sleep(float(action.split(":")[1]))
            return False
        if action.startswith("hang_drop:"):
            # sleep, then close without processing: the request never takes effect
            time.sleep(float(action.split(":")[1]))
            self.drop()
            return True
        return False

    def authed(self):
        a = self.headers.get("Authorization") or ""
        with LOCK:
            ok = a.startswith("Bearer ") and a[7:] in TOKENS
        if not ok:
            self.error(401, "missing or unknown bearer token")
        return ok

    # ── routing ──────────────────────────────────────────────────────────────
    def do_GET(self):
        self.route()

    def do_POST(self):
        self.route()

    def do_PUT(self):
        self.route()

    def do_DELETE(self):
        self.route()

    def do_PATCH(self):
        self.route()

    def route(self):
        u = urlparse(self.path)
        q = parse_qs(u.query, keep_blank_values=True)
        if u.path.startswith("/__control/"):
            return self.control(u, q)
        if u.path == "/v1/token":
            return self.sts(u, q)
        m = re.match(r"^/v1/projects/-/serviceAccounts/([^/:]+):generateAccessToken$", u.path)
        if m:
            return self.impersonate(u, q, m.group(1))
        m = re.match(r"^/upload/storage/v1/b/([^/]+)/o$", u.path)
        if m:
            return self.upload(u, q, m.group(1))
        m = re.match(r"^/storage/v1/b/([^/]+)/o$", u.path)
        if m and self.command == "GET":
            return self.list(u, q, m.group(1))
        # every other object/bucket operation is forbidden and recorded
        self.record(u, q, {"kind": "forbidden"})
        self.body()
        self.error(403, "operation not permitted for this identity (fake)")

    # ── control ──────────────────────────────────────────────────────────────
    def control(self, u, q):
        data = self.body()
        payload = json.loads(data) if data else {}
        with LOCK:
            if u.path == "/__control/reset":
                OBJECTS.clear(); SESSIONS.clear(); FAULTS.clear(); REQLOG.clear(); CLOCK[0] = 0.0
                return self.send(200, {"ok": True})
            if u.path == "/__control/fault":
                FAULTS.append({"match": payload.get("match", {}), "action": payload["action"], "times": int(payload.get("times", 1))})
                return self.send(200, {"ok": True, "faults": len(FAULTS)})
            if u.path == "/__control/clear_faults":
                FAULTS.clear()
                return self.send(200, {"ok": True})
            if u.path == "/__control/reqlog":
                return self.send(200, REQLOG)
            if u.path == "/__control/clear_reqlog":
                REQLOG.clear()
                return self.send(200, {"ok": True})
            if u.path == "/__control/objects":
                out = {k: {"live": v["live"], "noncurrent": v["noncurrent"]} for k, v in OBJECTS.items()}
                return self.send(200, out)
            if u.path == "/__control/object":
                k = payload["key"]
                if k not in OBJECTS or OBJECTS[k]["live"] is None:
                    return self.send(404, {"error": "absent"})
                return self.send(200, {"resource": OBJECTS[k]["live"], "content_b64": base64.b64encode(OBJECTS[k]["data"]).decode()})
            if u.path == "/__control/seed":
                # seed a foreign/poisoned/historic object with explicit fields
                k = payload["key"]
                data = base64.b64decode(payload.get("content_b64", "")) if payload.get("content_b64") else payload.get("content", "").encode()
                meta = {"contentType": payload.get("contentType", "application/octet-stream"), "metadata": payload.get("metadata", {})}
                res = make_resource(payload.get("bucket", "b"), k, data, meta, gen=payload.get("generation"), time_created=payload.get("timeCreated"))
                if payload.get("noncurrent"):
                    OBJECTS.setdefault(k, {"live": None, "data": b"", "noncurrent": []})
                    td = payload.get("timeDeleted", "now")
                    if td == "now":
                        res["timeDeleted"] = now_rfc3339()
                    elif td is not None:
                        res["timeDeleted"] = td
                    OBJECTS[k]["noncurrent"].append(res)
                else:
                    OBJECTS[k] = {"live": res, "data": data, "noncurrent": OBJECTS.get(k, {}).get("noncurrent", [])}
                return self.send(200, {"ok": True, "resource": res})
            if u.path == "/__control/oidc":
                # stand-in for the GitHub Actions OIDC token endpoint (ACTIONS_ID_TOKEN_REQUEST_URL)
                return self.send(200, {"value": "eyJhbGciOiJSUzI1NiJ9.FAKEGITHUBOIDC-SECRETTOKEN." + uuid.uuid4().hex})
            if u.path == "/__control/clock":
                CLOCK[0] = float(payload.get("offset", 0))
                return self.send(200, {"ok": True})
            if u.path == "/__control/delete":
                OBJECTS.pop(payload["key"], None)
                return self.send(200, {"ok": True})
        return self.error(404, "unknown control endpoint")

    # ── STS / IAM credentials ────────────────────────────────────────────────
    def sts(self, u, q):
        data = self.body()
        self.record(u, q, {"kind": "sts"})
        act = self.fault_for(u, q, "")
        if self.apply_fault(act):
            return
        try:
            req = json.loads(data)
        except Exception:
            return self.error(400, "invalid json")
        if req.get("grantType") != "urn:ietf:params:oauth:grant-type:token-exchange" or not req.get("subjectToken") or not req.get("audience"):
            return self.error(400, "invalid token exchange request")
        with LOCK:
            REQLOG[-1]["sts_scope"] = req.get("scope", "")
            REQLOG[-1]["sts_audience"] = req.get("audience", "")
            REQLOG[-1]["subject_token_prefix"] = req["subjectToken"][:8]
        tok = "fake-federated-SECRETTOKEN-" + uuid.uuid4().hex
        with LOCK:
            TOKENS.add(tok)
        self.send(200, {"access_token": tok, "issued_token_type": "urn:ietf:params:oauth:token-type:access_token", "token_type": "Bearer", "expires_in": 3600})

    def impersonate(self, u, q, sa):
        data = self.body()
        self.record(u, q, {"kind": "impersonate", "sa": sa})
        if not self.authed():
            return
        act = self.fault_for(u, q, "")
        if self.apply_fault(act):
            return
        tok = "fake-sa-SECRETTOKEN-" + uuid.uuid4().hex
        with LOCK:
            TOKENS.add(tok)
        self.send(200, {"accessToken": tok, "expireTime": "2099-01-01T00:00:00Z"})

    # ── uploads ──────────────────────────────────────────────────────────────
    def upload(self, u, q, bucket):
        utype = q.get("uploadType", [""])[0]
        if utype == "resumable" and self.command == "POST":
            return self.resumable_init(u, q, bucket)
        if utype == "resumable" and self.command == "PUT":
            return self.resumable_put(u, q, bucket)
        if utype == "multipart" and self.command == "POST":
            return self.multipart(u, q, bucket)
        self.body()
        self.record(u, q, {"kind": "forbidden"})
        self.error(403, "unsupported upload operation (fake)")

    def precondition_fail(self, key, q):
        ifgm = q.get("ifGenerationMatch", [None])[0]
        if ifgm is None:
            return None  # no precondition supplied
        with LOCK:
            live = OBJECTS.get(key, {}).get("live")
        if ifgm == "0":
            return live is not None
        return live is None or live["generation"] != ifgm

    def finalize(self, bucket, key, meta, data, q, ifgm):
        # precondition then md5 validation then create; returns (code, obj)
        with LOCK:
            live = OBJECTS.get(key, {}).get("live")
            if ifgm is None:
                pass
            elif ifgm == "0" and live is not None:
                return 412, {"error": {"code": 412, "message": "conditionNotMet"}}
            elif ifgm != "0" and (live is None or live["generation"] != ifgm):
                return 412, {"error": {"code": 412, "message": "conditionNotMet"}}
            if meta.get("md5Hash") and meta["md5Hash"] != md5_b64(data):
                return 400, {"error": {"code": 400, "message": "Provided MD5 hash does not match calculated (fake)"}}
            res = make_resource(bucket, key, data, meta)
            entry = OBJECTS.setdefault(key, {"live": None, "data": b"", "noncurrent": []})
            if entry["live"] is not None:
                old = dict(entry["live"]); old["timeDeleted"] = now_rfc3339(); entry["noncurrent"].append(old)
            entry["live"] = res; entry["data"] = data
            return 200, res

    def resumable_init(self, u, q, bucket):
        data = self.body()
        try:
            meta = json.loads(data) if data else {}
        except Exception:
            meta = {}
        key = q.get("name", [meta.get("name", "")])[0]
        self.record(u, q, {"kind": "resumable_init", "name": key, "if_generation_match": q.get("ifGenerationMatch", [None])[0],
                           "upload_content_length": self.headers.get("X-Upload-Content-Length", "")})
        if not self.authed():
            return
        act = self.fault_for(u, q, key)
        if self.apply_fault(act):
            return
        ifgm = q.get("ifGenerationMatch", [None])[0]
        if ifgm == "0":
            with LOCK:
                if OBJECTS.get(key, {}).get("live") is not None:
                    return self.error(412, "conditionNotMet")
        sid = uuid.uuid4().hex
        total = int(self.headers.get("X-Upload-Content-Length") or 0)
        with LOCK:
            SESSIONS[sid] = {"bucket": bucket, "key": key, "meta": meta, "received": bytearray(), "total": total, "ifgm": ifgm, "done": None}
        loc = "http://127.0.0.1:%d/upload/storage/v1/b/%s/o?uploadType=resumable&upload_id=%s" % (SERVER_PORT[0], bucket, sid)
        self.send(200, {}, headers={"Location": loc})

    def resumable_put(self, u, q, bucket):
        sid = q.get("upload_id", [""])[0]
        cr = self.headers.get("Content-Range", "")
        data = self.body()
        with LOCK:
            s = SESSIONS.get(sid)
        self.record(u, q, {"kind": "resumable_put", "name": s["key"] if s else "", "status_query": cr.startswith("bytes */"), "bytes": len(data)})
        if not self.authed():
            return
        if s is None:
            return self.error(404, "unknown upload session")
        act = self.fault_for(u, q, s["key"] + ("|status" if cr.startswith("bytes */") else "|data"))
        store_then = False
        if act == "store_then_drop":
            store_then = True
        elif act and act.startswith("store_then_hang:"):
            store_then = True
        elif self.apply_fault(act):
            return
        with LOCK:
            if cr.startswith("bytes */"):
                if s["done"] is not None:
                    code, obj = s["done"]
                    return self.send(code, obj)
                n = len(s["received"])
                if n == 0:
                    return self.send(308, {}, headers={})
                return self.send(308, {}, headers={"Range": "bytes=0-%d" % (n - 1)})
            m = re.match(r"^bytes (\d+)-(\d+)/(\d+)$", cr)
            if m:
                start, end, total = int(m.group(1)), int(m.group(2)), int(m.group(3))
                if start != len(s["received"]):
                    return self.error(400, "unexpected offset")
                s["received"] += data
                s["total"] = total
            else:
                s["received"] = bytearray(data)
                if s["total"] == 0:
                    s["total"] = len(data)
            if len(s["received"]) < s["total"]:
                return self.send(308, {}, headers={"Range": "bytes=0-%d" % (len(s["received"]) - 1)})
        code, obj = self.finalize(s["bucket"], s["key"], s["meta"], bytes(s["received"]), q, s["ifgm"])
        with LOCK:
            s["done"] = (code, obj)
        if store_then:
            if act.startswith("store_then_hang:"):
                time.sleep(float(act.split(":")[1]))
            self.drop()
            return
        self.send(code, obj)

    def multipart(self, u, q, bucket):
        data = self.body()
        ct = self.headers.get("Content-Type", "")
        m = re.search(r'boundary="?([^";]+)"?', ct)
        if not m:
            self.record(u, q, {"kind": "multipart", "name": ""})
            return self.error(400, "missing boundary")
        b = m.group(1).encode()
        parts = data.split(b"--" + b)
        # parts[0] is the preamble, last is the epilogue after "--"
        bodies = []
        for p in parts[1:-1]:
            p = p[2:] if p.startswith(b"\r\n") else p
            head, _, content = p.partition(b"\r\n\r\n")
            if content.endswith(b"\r\n"):
                content = content[:-2]
            bodies.append((head, content))
        if len(bodies) != 2:
            self.record(u, q, {"kind": "multipart", "name": ""})
            return self.error(400, "expected two parts")
        try:
            meta = json.loads(bodies[0][1])
        except Exception:
            self.record(u, q, {"kind": "multipart", "name": ""})
            return self.error(400, "invalid metadata part")
        key = meta.get("name", "")
        self.record(u, q, {"kind": "multipart", "name": key, "if_generation_match": q.get("ifGenerationMatch", [None])[0], "bytes": len(bodies[1][1])})
        if not self.authed():
            return
        act = self.fault_for(u, q, key)
        store_then = act == "store_then_drop" or (act or "").startswith("store_then_hang:")
        if not store_then and self.apply_fault(act):
            return
        code, obj = self.finalize(bucket, key, meta, bodies[1][1], q, q.get("ifGenerationMatch", [None])[0])
        if store_then:
            if act.startswith("store_then_hang:"):
                time.sleep(float(act.split(":")[1]))
            self.drop()
            return
        self.send(code, obj)

    # ── list ─────────────────────────────────────────────────────────────────
    def list(self, u, q, bucket):
        self.body()
        prefix = q.get("prefix", [""])[0]
        versions = q.get("versions", ["false"])[0] == "true"
        max_results = int(q.get("maxResults", ["1000"])[0])
        page = int(q.get("pageToken", ["0"])[0] or 0)
        self.record(u, q, {"kind": "list", "prefix": prefix, "versions": versions, "fields": q.get("fields", [""])[0]})
        if not self.authed():
            return
        act = self.fault_for(u, q, prefix)
        if self.apply_fault(act):
            return
        items = []
        with LOCK:
            for k in sorted(OBJECTS):
                if not k.startswith(prefix):
                    continue
                e = OBJECTS[k]
                if e["live"] is not None:
                    items.append(e["live"])
                if versions:
                    items.extend(e["noncurrent"])
        chunk = items[page:page + max_results]
        out = {"kind": "storage#objects", "items": chunk}
        if page + max_results < len(items):
            out["nextPageToken"] = str(page + max_results)
        self.send(200, out)


SERVER_PORT = [PORT]


def main():
    os.makedirs(STATE_DIR, exist_ok=True)
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    srv.daemon_threads = True
    SERVER_PORT[0] = srv.server_address[1]
    with open(os.path.join(STATE_DIR, "port"), "w") as fh:
        fh.write(str(SERVER_PORT[0]))
    srv.serve_forever()


if __name__ == "__main__":
    main()
