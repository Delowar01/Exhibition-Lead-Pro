// Pure, framework-free normalization of export filters. Kept separate from
// export-share.ts (which imports react-native) so it can be unit-tested under a
// plain node environment. Drops empty/null/"all" sentinels and stringifies the
// rest, so only real, server-supported filter values reach the export API.
export function cleanFilters(
  filters: Record<string, string | number | undefined | null>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(filters)) {
    if (v == null || v === "" || v === "all") continue;
    out[k] = String(v);
  }
  return out;
}
