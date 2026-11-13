// Batch 41 — database-target classification for operator scripts (PURE).
//
// A maintenance script must never infer "this is not production" from
// NODE_ENV alone: the variable is a runtime mode, not proof of which database a
// connection string points at. Scripts that write (backfills) classify the
// configured DATABASE_URL by its host and require an EXPLICIT, matching
// `--expect-host` for anything that is not a loopback address; applying changes
// to a remote host additionally requires the production confirmation flag.
// Nothing here reads process.env or opens a connection.

export type DatabaseTargetClass = "local" | "remote" | "invalid";

export interface DatabaseTarget {
  class: DatabaseTargetClass;
  host: string | null;
  database: string | null;
  // Never includes credentials: safe to print in a report.
  display: string;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function classifyDatabaseTarget(url: string | undefined | null): DatabaseTarget {
  if (!url || typeof url !== "string" || url.trim() === "") return { class: "invalid", host: null, database: null, display: "(unset)" };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { class: "invalid", host: null, database: null, display: "(unparseable)" };
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) return { class: "invalid", host: null, database: null, display: `(unsupported scheme ${parsed.protocol})` };
  const host = parsed.hostname.toLowerCase();
  if (!host) return { class: "invalid", host: null, database: null, display: "(no host)" };
  const database = parsed.pathname.replace(/^\//, "") || null;
  const display = `${host}${parsed.port ? `:${parsed.port}` : ""}/${database ?? ""}`;
  return { class: LOCAL_HOSTS.has(host) ? "local" : "remote", host, database, display };
}

export interface TargetGuardInput {
  url: string | undefined | null;
  nodeEnv: string | undefined;
  expectHost: string | undefined;
  confirmProduction: boolean;
  apply: boolean;
}

export type TargetGuardResult = { ok: true; target: DatabaseTarget } | { ok: false; target: DatabaseTarget; code: TargetGuardCode; message: string };

export type TargetGuardCode = "DATABASE_URL_INVALID" | "EXPECT_HOST_REQUIRED" | "EXPECT_HOST_MISMATCH" | "PRODUCTION_CONFIRMATION_REQUIRED";

// Decision table (fail closed):
//   invalid URL                                     → refuse
//   NODE_ENV=production without --confirm-production → refuse (never silently)
//   remote host (anything not loopback)
//       without --expect-host                        → refuse (explicit target required)
//       --expect-host ≠ actual host                  → refuse
//       --apply without --confirm-production         → refuse
//   local host with --expect-host ≠ actual host      → refuse (an explicit expectation is always honoured)
export function guardDatabaseTarget(input: TargetGuardInput): TargetGuardResult {
  const target = classifyDatabaseTarget(input.url);
  if (target.class === "invalid") return { ok: false, target, code: "DATABASE_URL_INVALID", message: `DATABASE_URL is not a usable postgres URL ${target.display}` };
  const expect = input.expectHost?.trim().toLowerCase();
  if (expect !== undefined && expect !== "" && expect !== target.host) {
    return { ok: false, target, code: "EXPECT_HOST_MISMATCH", message: `--expect-host "${expect}" does not match the configured database host "${target.host}"` };
  }
  if (input.nodeEnv === "production" && !input.confirmProduction) {
    return { ok: false, target, code: "PRODUCTION_CONFIRMATION_REQUIRED", message: "NODE_ENV=production: --confirm-production is required (owner authorization)" };
  }
  if (target.class === "remote") {
    if (!expect) return { ok: false, target, code: "EXPECT_HOST_REQUIRED", message: `the configured database host "${target.host}" is not a loopback address; pass --expect-host ${target.host} to confirm the target explicitly` };
    if (input.apply && !input.confirmProduction) {
      return { ok: false, target, code: "PRODUCTION_CONFIRMATION_REQUIRED", message: `applying changes to the non-local database host "${target.host}" requires --confirm-production (owner authorization); NODE_ENV is never taken as proof of a non-production database` };
    }
  }
  return { ok: true, target };
}


// ---------------------------------------------------------------------------
// Batch 42 — database IDENTITY verification (PURE decision; facts are collected
// separately, after the URL guard, by collectDatabaseIdentity).
//
// Why the URL guard alone is not enough: an SSH tunnel (`ssh -L 5432:…`), a
// forwarded container port or a copied .env can make `localhost:5432` point at
// a database that is not local at all — the URL still classifies as "local"
// and no flag is required. The identity layer therefore verifies what the
// CONNECTED server says about itself, and refuses when that evidence
// contradicts the operator's stated expectation or the URL classification.
//
// Facts (all nullable — a missing fact is never treated as a match):
//   database          current_database()
//   serverAddr        inet_server_addr()  (null for a Unix-socket connection)
//   systemIdentifier  pg_control_system().system_identifier (null when the role
//                     may not read it — it is superuser-only by default)
//   environmentMarker the `environment=<name>` key of the database comment
//                     (`COMMENT ON DATABASE … IS 'environment=production'`),
//                     readable by every role; null when the database carries none
//
// Decision table (fail closed):
//   --expect-database ≠ current_database()                 → refuse (always)
//   --apply without --expect-database                      → refuse
//   --expect-system-id given, fact unreadable              → refuse (cannot verify)
//   --expect-system-id ≠ system_identifier                 → refuse
//   --expect-environment given, database carries no marker → refuse (cannot verify)
//   --expect-environment ≠ marker                          → refuse
//   database marked environment=production
//       without --confirm-production                       → refuse (even a dry run)
//       --apply without --expect-environment production    → refuse
//   database carries ANY marker and --apply
//       without --expect-environment                       → refuse (a marked
//                                                           database is always
//                                                           named explicitly)
//   URL host is loopback but the server reports a
//   non-loopback inet_server_addr()                        → forwarded connection
//       without --allow-forwarded                          → refuse (dry run too)
//       --apply without --confirm-production               → refuse (the target
//                                                           is not provably local)
// Nothing here reads process.env or opens a connection.

export interface DatabaseIdentityFacts {
  database: string | null;
  serverAddr: string | null;
  serverPort: number | null;
  systemIdentifier: string | null;
  environmentMarker: string | null;
  serverVersion: string | null;
  postmasterStartedAt: string | null;
  clusterName: string | null;
}

export interface IdentityGuardInput {
  target: DatabaseTarget;
  facts: DatabaseIdentityFacts;
  apply: boolean;
  confirmProduction: boolean;
  allowForwarded: boolean;
  expectDatabase: string | undefined;
  expectSystemId: string | undefined;
  expectEnvironment: string | undefined;
}

export type IdentityGuardCode =
  | "EXPECT_DATABASE_REQUIRED"
  | "EXPECT_DATABASE_MISMATCH"
  | "SYSTEM_ID_UNAVAILABLE"
  | "SYSTEM_ID_MISMATCH"
  | "ENVIRONMENT_MARKER_MISSING"
  | "ENVIRONMENT_MARKER_MISMATCH"
  | "ENVIRONMENT_EXPECTATION_REQUIRED"
  | "PRODUCTION_CONFIRMATION_REQUIRED"
  | "FORWARDED_CONNECTION_SUSPECTED";

export interface IdentitySummary {
  // Never includes credentials: safe to print in a report / evidence record.
  database: string | null;
  serverAddr: string | null;
  serverPort: number | null;
  systemIdentifier: string | null;
  environmentMarker: string | null;
  forwarded: boolean;
  serverVersion: string | null;
  postmasterStartedAt: string | null;
  clusterName: string | null;
}

export type IdentityGuardResult =
  | { ok: true; identity: IdentitySummary; warnings: string[] }
  | { ok: false; identity: IdentitySummary; code: IdentityGuardCode; message: string; warnings: string[] };

const PRODUCTION_MARKER = "production";

export function isLoopbackAddress(addr: string | null | undefined): boolean {
  if (!addr) return false;
  const a = addr.trim().toLowerCase().replace(/\/\d+$/, "");
  if (a === "::1" || a === "[::1]" || a === "localhost") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a)) return true;
  // IPv4-mapped loopback (::ffff:127.0.0.1)
  if (/^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a)) return true;
  return false;
}

// `environment=<name>` anywhere in the database comment (first key wins); the
// value is a short lowercase token — anything else is ignored (no marker).
export function parseEnvironmentMarker(comment: string | null | undefined): string | null {
  if (!comment || typeof comment !== "string") return null;
  const m = /(?:^|[\s;,])environment\s*=\s*([a-z][a-z0-9_-]{0,31})(?=$|[\s;,])/i.exec(comment);
  return m ? m[1].toLowerCase() : null;
}

function summarize(input: IdentityGuardInput, forwarded: boolean): IdentitySummary {
  const f = input.facts;
  return {
    database: f.database,
    serverAddr: f.serverAddr,
    serverPort: f.serverPort,
    systemIdentifier: f.systemIdentifier,
    environmentMarker: f.environmentMarker,
    forwarded,
    serverVersion: f.serverVersion,
    postmasterStartedAt: f.postmasterStartedAt,
    clusterName: f.clusterName,
  };
}

function norm(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t === undefined || t === "" ? undefined : t;
}

export function verifyDatabaseIdentity(input: IdentityGuardInput): IdentityGuardResult {
  const f = input.facts;
  const forwarded = input.target.class === "local" && f.serverAddr !== null && !isLoopbackAddress(f.serverAddr);
  const identity = summarize(input, forwarded);
  const warnings: string[] = [];
  const refuse = (code: IdentityGuardCode, message: string): IdentityGuardResult => ({ ok: false, identity, code, message, warnings });

  const expectDatabase = norm(input.expectDatabase);
  const expectSystemId = norm(input.expectSystemId);
  const expectEnvironment = norm(input.expectEnvironment)?.toLowerCase();

  // 1. The database name is the baseline identity fact: an expectation is always
  //    honoured, and applying changes always requires one.
  if (expectDatabase !== undefined && expectDatabase !== f.database) {
    return refuse("EXPECT_DATABASE_MISMATCH", `--expect-database "${expectDatabase}" does not match the connected database "${f.database ?? "(unknown)"}"`);
  }
  if (input.apply && expectDatabase === undefined) {
    return refuse("EXPECT_DATABASE_REQUIRED", `--apply requires --expect-database <name> naming the connected database (currently "${f.database ?? "(unknown)"}")`);
  }

  // 2. Cluster identity (optional expectation; an unreadable fact never matches).
  if (expectSystemId !== undefined) {
    if (f.systemIdentifier === null) return refuse("SYSTEM_ID_UNAVAILABLE", "--expect-system-id was given but the connected role may not read pg_control_system(); the expectation cannot be verified");
    if (f.systemIdentifier !== expectSystemId) return refuse("SYSTEM_ID_MISMATCH", `--expect-system-id "${expectSystemId}" does not match the connected cluster's system identifier "${f.systemIdentifier}"`);
  }
  if (f.systemIdentifier === null) warnings.push("cluster system identifier not readable by this role (pg_control_system() is superuser-only by default); identity rests on the database name, marker and server address");

  // 3. Environment marker (what the DATABASE declares about itself).
  if (expectEnvironment !== undefined) {
    if (f.environmentMarker === null) return refuse("ENVIRONMENT_MARKER_MISSING", `--expect-environment "${expectEnvironment}" was given but the connected database carries no environment marker (COMMENT ON DATABASE … IS 'environment=<name>')`);
    if (f.environmentMarker !== expectEnvironment) return refuse("ENVIRONMENT_MARKER_MISMATCH", `--expect-environment "${expectEnvironment}" does not match the connected database's marker "${f.environmentMarker}"`);
  }
  if (f.environmentMarker === PRODUCTION_MARKER) {
    if (!input.confirmProduction) return refuse("PRODUCTION_CONFIRMATION_REQUIRED", "the connected database declares environment=production: --confirm-production (owner authorization) is required, for a dry run as well");
    if (input.apply && expectEnvironment !== PRODUCTION_MARKER) return refuse("ENVIRONMENT_EXPECTATION_REQUIRED", "the connected database declares environment=production: --apply requires --expect-environment production as an explicit acknowledgement");
  } else if (f.environmentMarker !== null && input.apply && expectEnvironment === undefined) {
    return refuse("ENVIRONMENT_EXPECTATION_REQUIRED", `the connected database declares environment=${f.environmentMarker}: --apply requires --expect-environment ${f.environmentMarker}`);
  }
  if (f.environmentMarker === null) warnings.push("the connected database carries no environment marker; set one per environment (see docs/PLAN_VERSION_BACKFILL_RUNBOOK.md) so the identity check can name it");

  // 4. Forwarded connection: the URL said loopback, the server says otherwise.
  if (forwarded) {
    if (!input.allowForwarded) return refuse("FORWARDED_CONNECTION_SUSPECTED", `DATABASE_URL points at a loopback host but the server reports its address as "${f.serverAddr}": the connection is forwarded (SSH tunnel / port forward / container proxy). Re-run with --allow-forwarded only after confirming WHICH database the tunnel reaches`);
    if (input.apply && !input.confirmProduction) return refuse("PRODUCTION_CONFIRMATION_REQUIRED", "applying changes over a forwarded connection requires --confirm-production (owner authorization): the target is not provably local");
    warnings.push(`forwarded connection acknowledged (--allow-forwarded): server address ${f.serverAddr}`);
  }
  return { ok: true, identity, warnings };
}
