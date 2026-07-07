# Stage 5.9 — Phase 2 Report: Navigation & Information Architecture

**Date:** July 7, 2026
**Scope:** Web (both portals) + Mobile navigation modernization. **Zero API/RBAC changes** — this phase touched only frontend navigation, routing, and i18n resources.

---

## 1. Blueprint (delivered first)

`docs/design-system/navigation-blueprint.md` — full sitemaps for both web portals and mobile, permission matrix per nav item (exact existing gates reused: `canViewDocuments`, `canViewAssistant`, `canViewExecutive`), and a Mermaid IA diagram.

Deliberate deferrals recorded in the blueprint:
- **Web language switch** — web has no i18n layer today; adding one is out of Phase 2 scope.
- **Lead search in the command palette** — `listLeads` has no search parameter; palette record search is contacts-only.

## 2. Web — grouped sidebar

- `src/components/layouts/navigation.tsx` — single source of truth: `buildAdminNav()` / `buildPlatformNav()` return grouped nav models, gated by the exact pre-existing permission helpers (no new gates, no loosened gates).
- `src/components/layouts/SidebarNav.tsx` — collapsible groups with persisted open/closed state (`localStorage`: `csp_nav_admin` / `csp_nav_platform`), the group containing the active route is forced open, full ARIA (`aria-expanded`, `aria-current`).
- `AdminLayout` / `PlatformLayout` rewritten to host the new sidebar + header in the main column.

## 3. Web — global header + command palette

- `AppHeader.tsx` — search trigger (opens palette), quick-create menu, AI shortcut, notifications bell with `useGetUnreadCount` (admin portal only), theme toggle, user menu; global `⌘K` / `Ctrl+K` listener.
- `CommandPalette.tsx` (cmdk) — recents (`localStorage` `csp_recent`), navigation commands, quick-create actions, AI shortcuts, and live contact search via `useListContacts({ search, limit: 6 })` (enabled at ≥2 chars). Contact display name falls back `fullName → first+last → email`.

## 4. Web — route-level code splitting

- `App.tsx` converted to `React.lazy` + `Suspense` for all portal pages (~45 routes). A `RouteFallback` skeleton renders during chunk load.
- Login, NotFound, and public pages (public card, forgot/reset password, verify email, accept invite) stay **eager** for fast first paint.
- Fixed a TDZ crash found in verification: the `lazy` import must precede the module-level `lazy(...)` calls (import hoisting does not cover Vite's runtime-error overlay evaluation order); `useEffect/lazy/Suspense` import moved to the top of the module.

## 5. Mobile — tab restructure (Home / Scan / Leads / Notifications / More)

- Tabs are now: **Home** (`index`), **Scan** (`capture`, relabeled `nav.scan`), **Leads** (moved `app/leads.tsx` → `app/(tabs)/leads.tsx`; back button now renders only when `router.canGoBack()`), **Notifications** (new), **More**.
- **Contacts** and **Follow-Ups** moved out of the tab bar to stack screens (`app/contacts.tsx`, `app/followups.tsx`); all internal route references updated; no dangling `/(tabs)/contacts|followups` references remain.
- Both tab implementations updated (`NativeTabs` with SF Symbols and the classic `Tabs` layout). Classic layout shows an unread badge on the Notifications tab (`useGetUnreadCount`, 60s refetch, enabled only when authenticated).

### New Notifications screen (`app/(tabs)/notifications.tsx`)

- `useListNotifications` + `useGetUnreadCount` + `useMarkNotificationRead` + `useMarkAllNotificationsRead` (all pre-existing generated hooks — no API changes).
- Category icons, unread indicators, relative timestamps via `Intl.RelativeTimeFormat` (locale-aware), pull-to-refresh, `flexGrow: 1` empty state, mark-one-on-tap and mark-all-read.

### More screen regrouped

Sections: **Communications** (reserved, disabled entry labeled "Coming in Stage 5.5"), **CRM** (Contacts, Companies, Follow-Ups, Meetings, Tasks, Events, Duplicates), **AI Intelligence** (Command Center / Workflow / Executive — same permission gates as before), **My Workspace** (Digital Card, My Numbers, Sync), **Settings** (+ dev-only performance screen). Groups render as titled cards with RTL-aware rows.

## 6. i18n (EN/AR parity preserved)

Added to both `en.json` and `ar.json`: `nav.scan`, `nav.notifications`, the `notifCenter.*` namespace (with full Arabic plural forms for unread counts), and `more.group*` / `more.commsTitle` / `more.commsSoon` / `more.followupsSub`. RTL behavior verified through the existing `isRTL`/`textAlign` locale hooks used on every new surface.

## 7. Verification

- `pnpm run typecheck` — **clean** across all packages (libs + web-app + mobile + api-server + scripts + pitch-deck).
- Full api-server test suite run against the live API after an api-server workflow restart (login-limiter protocol) — result recorded below.
- Web preview verified: login renders correctly after the lazy-import fix (screenshot: `docs/reports/assets/stage-5.9-phase2-web-login.jpg`).
- **Zero** changes under `lib/api-spec`, `lib/db`, or `artifacts/api-server` — API and RBAC surfaces untouched.

### Test suite result

`pnpm --filter @workspace/api-server run test` (vitest, live API + seeded demo tenants, after api-server restart per the login-limiter protocol): **29 test files passed, 555 tests passed, 0 failures** (duration ~257s).

### Architect review

An independent architect review of the full diff flagged one blocking gap — the mobile notifications screen ignored `notification.link` — which was fixed: web-portal links are now mapped to their mobile counterparts (`/admin/leads/:id` → `/pipeline/:id`, `/admin/contacts/:id` → `/contact/:id`, `/admin/workflow` → `/workflow`, list fallbacks) and unknown/external links are safely ignored. No permission-gate regressions, RTL/i18n issues, or stale-route references were found.

---

**Phase 2 is complete. Work stops here per the Stage 5.9 directive — Phase 3 begins only after owner review.**
