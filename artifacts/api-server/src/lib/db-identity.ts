// Batch 42 — collection of database IDENTITY facts for operator scripts.
//
// Runs AFTER the pure URL guard (src/lib/db-target.ts) has accepted the
// configured DATABASE_URL and BEFORE any application module touches the
// database. Every fact is read-only; a fact the connected role may not read
// (pg_control_system() is superuser-only by default) is reported as null and
// never treated as a match by verifyDatabaseIdentity.
//
// The query executor is injected so the collector is testable against any
// client and never opens a connection of its own.
import { parseEnvironmentMarker, type DatabaseIdentityFacts } from "./db-target.js";

export type SqlRowQuery = (sql: string) => Promise<Array<Record<string, unknown>>>;

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return typeof v === "string" ? v : String(v);
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function collectDatabaseIdentity(query: SqlRowQuery): Promise<DatabaseIdentityFacts> {
  const [base] = await query(
    "select current_database() as database, inet_server_addr()::text as server_addr, inet_server_port() as server_port, " +
      "version() as server_version, pg_postmaster_start_time() as started_at, current_setting('cluster_name', true) as cluster_name, " +
      "shobj_description((select oid from pg_database where datname = current_database()), 'pg_database') as db_comment",
  );
  let systemIdentifier: string | null = null;
  try {
    const [row] = await query("select system_identifier::text as system_identifier from pg_control_system()");
    systemIdentifier = str(row?.system_identifier);
  } catch {
    systemIdentifier = null; // not permitted for this role — never a match
  }
  const startedAt = base?.started_at;
  return {
    database: str(base?.database),
    serverAddr: str(base?.server_addr),
    serverPort: num(base?.server_port),
    systemIdentifier,
    environmentMarker: parseEnvironmentMarker(str(base?.db_comment)),
    serverVersion: str(base?.server_version),
    postmasterStartedAt: startedAt instanceof Date ? startedAt.toISOString() : str(startedAt),
    clusterName: str(base?.cluster_name) || null,
  };
}
