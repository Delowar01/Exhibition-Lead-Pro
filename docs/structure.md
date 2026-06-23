# Logical Structure Map

_How the existing layout already fulfills an apps / packages / services model._

A common enterprise expectation is a clean split between **apps** (deployable
products), **packages** (shared libraries), and **services** (long-running
backends). Card Scanner Pro already satisfies this model with its current folders
— **no physical rename is required**. This document maps the existing layout onto
those roles so the conceptual model and the on-disk reality line up.

## 1. Folder view (current = recommended)

```
workspace/
├── artifacts/            # APPS (and the one SERVICE)
│   ├── api-server/       # SERVICE  — Express 5 API (the backend)
│   ├── web-app/          # APP      — React + Vite admin/platform portals
│   ├── mobile/           # APP      — Expo / React Native client
│   ├── pitch-deck/       # APP      — slides artifact
│   └── mockup-sandbox/   # APP      — design/preview surface (canvas)
│
├── lib/                  # PACKAGES (shared libraries)
│   ├── api-spec/         # OpenAPI contract + Orval codegen config
│   ├── api-zod/          # Generated Zod schemas (validation)
│   ├── api-client-react/ # Generated React Query hooks + fetch wrapper
│   ├── db/               # Drizzle ORM schema + connection pool
│   └── integrations-gemini-ai/  # Gemini AI integration wrapper
│
├── scripts/              # PACKAGE — shared utility scripts (@workspace/scripts)
├── docs/                 # this documentation tree
└── replit.md             # root overview + user preferences (stays at root)
```

There is no `apps/`, `packages/`, or `services/` directory to create:
`artifacts/` already serves as the apps tier (with `api-server` as the lone
service), and `lib/` already serves as the packages tier. Renaming them would
break workflows, the proxy routing in each `.replit-artifact/artifact.toml`, and
TypeScript project references for zero functional gain.

## 2. Role map

### Apps (`artifacts/`)

| Package | `@workspace/` name | Role | Notes |
|---|---|---|---|
| `api-server` | `@workspace/api-server` | **Service** | Express 5 backend; proxied at `/api`. The only long-running server. |
| `web-app` | `@workspace/web-app` | App | React 19 + Vite; Platform (`/platform`) and Admin (`/admin`) portals. |
| `mobile` | `@workspace/mobile` | App | Expo / React Native; the field lead-capture client. |
| `pitch-deck` | `@workspace/pitch-deck` | App | Slides artifact. |
| `mockup-sandbox` | `@workspace/mockup-sandbox` | App | Design/preview surface for component prototyping. |

### Packages (`lib/` + `scripts/`)

| Package | `@workspace/` name | Role | Consumed by |
|---|---|---|---|
| `api-spec` | `@workspace/api-spec` | Contract + codegen | (build-time) generates `api-zod` + `api-client-react` |
| `api-zod` | `@workspace/api-zod` | Validation schemas | `api-server` (in + out), clients |
| `api-client-react` | `@workspace/api-client-react` | React Query hooks | `web-app`, `mobile` |
| `db` | `@workspace/db` | Drizzle schema + pool | `api-server` |
| `integrations-gemini-ai` | `@workspace/integrations-gemini-ai` | AI integration | `api-server` |
| `scripts` | `@workspace/scripts` | Utility scripts | repo tooling |

## 3. Dependency direction

Dependencies flow **apps → packages**, never the reverse, and `artifacts/*` never
import each other (shared logic must move into a `lib/*` package):

```
api-server ──► api-zod ──► (generated from api-spec)
api-server ──► db
api-server ──► integrations-gemini-ai
web-app    ──► api-client-react ──► (generated from api-spec)
mobile     ──► api-client-react
```

## 4. TypeScript project model

- `lib/*` packages are **composite** and emit declarations via `tsc --build`.
  They are listed in the root [`tsconfig.json`](../tsconfig.json) `references`.
- `artifacts/*` and `scripts` are **leaf** packages, typechecked with
  `tsc --noEmit`; they are **not** added to the root references.
- Shared strict defaults live in [`tsconfig.base.json`](../tsconfig.base.json).
- `pnpm run typecheck` builds the libs first, then runs leaf typechecks. Trust
  this over editor/LSP state when they disagree.

See the `pnpm-workspace` skill and [Developer Guide](developer-guide.md) for the
day-to-day commands.
