#!/bin/bash
# =============================================================================
# B30 — OWNER key-id check (runs on the OWNER'S machine only; never on the VPS, never pasted into chat).
# Computes the NON-SECRET key id of an offline recovery copy of OBJECT_STORAGE_ENCRYPTION_KEY exactly as
# the product does (keyIdOf: the first 16 hex characters of SHA-256 over the 32 raw key bytes; the value
# may be stored as 64 hex characters or as base64 of 32 bytes). The value is read from a FILE (never from
# the command line, never echoed). Prints ONLY the 16-hex key id. The owner compares it with the line
# envelope_key_id=… of the recovery-set manifest (or with the header of any object) and reports only the
# word MATCH or MISMATCH — never the id, never the value.
# Usage: bash b30-keyid-owner.sh <file whose single line is the key value>
# =============================================================================
set -euo pipefail
umask 077
f="${1:?usage: b30-keyid-owner.sh <file containing the key value>}"
[ -f "$f" ] || { echo "not a file" >&2; exit 1; }
v="$(tr -d '[:space:]' < "$f")"
# portable hex decoder (stdin → raw bytes): xxd, else python3, else perl — the value never appears on a command line
hexdec() {
  if command -v xxd >/dev/null 2>&1; then xxd -r -p
  elif command -v python3 >/dev/null 2>&1; then python3 -c 'import sys,binascii; sys.stdout.buffer.write(binascii.unhexlify(sys.stdin.read().strip()))'
  elif command -v perl >/dev/null 2>&1; then perl -ne 'chomp; print pack("H*", $_)'
  else echo "no hex decoder (xxd / python3 / perl) available" >&2; exit 1; fi
}
if [[ "$v" =~ ^[0-9a-fA-F]{64}$ ]]; then
  printf '%s' "$v" | hexdec | sha256sum | cut -c1-16
elif [ "$(printf '%s' "$v" | base64 -d 2>/dev/null | wc -c)" = "32" ]; then
  printf '%s' "$v" | base64 -d | sha256sum | cut -c1-16
else
  echo "the key value is neither 64 hex characters nor base64 of exactly 32 bytes" >&2
  exit 1
fi
