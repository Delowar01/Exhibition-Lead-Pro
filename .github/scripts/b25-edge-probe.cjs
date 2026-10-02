// TEMPORARY — B25 Phase 2A edge upload-limit probe (ONE-OFF ops script, not
// application code). From the GitHub runner, sends ONLY the request headers of a
// PUT to the B25 upload route with `Expect: 100-continue` and a declared
// Content-Length, then closes the connection: nginx layers answer 413 before
// any proxying when the declared length exceeds their client_max_body_size, and
// 100 Continue when every layer accepts it. No body byte is ever sent, no
// session is used, nothing is stored. Prints status codes only.
"use strict";
const https = require("node:https");
const http = require("node:http");

const targets = (process.env.PROBE_TARGETS || "https://admin.kaptnow.com,https://elite.kaptnow.com").split(",").map((s) => s.trim()).filter(Boolean);
const MiB = 1024 * 1024;
const sizes = [
  ["1 MiB", 1 * MiB],
  ["25 MiB", 25 * MiB],
  ["30 MiB", 30 * MiB],
  ["30 MiB + 1 B", 30 * MiB + 1],
  ["31 MiB", 31 * MiB],
  ["100 MiB", 100 * MiB],
  ["1 GiB", 1024 * MiB],
];
const path = "/api/files/uploads/00000000-0000-4000-8000-000000000000";

function probe(base, bytes) {
  return new Promise((resolve) => {
    const u = new URL(base);
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      {
        host: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path,
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream", "Content-Length": bytes, Expect: "100-continue", "User-Agent": "b25-edge-probe" },
        timeout: 15000,
      },
      (res) => {
        resolve(`${res.statusCode} server=${String(res.headers.server || "-").split("/")[0]}`);
        res.resume();
        req.destroy();
      },
    );
    req.on("continue", () => {
      resolve("100 (headers accepted by every layer)");
      req.destroy();
    });
    req.on("timeout", () => {
      resolve("timeout");
      req.destroy();
    });
    req.on("error", (e) => resolve(`error:${e.code || "x"}`));
  });
}

(async () => {
  for (const base of targets) {
    console.log(`target ${base}${path} (PUT, headers only)`);
    for (const [label, bytes] of sizes) console.log(`  ${label.padEnd(13)} -> ${await probe(base, bytes)}`);
  }
})();
