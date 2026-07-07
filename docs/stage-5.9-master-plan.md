# Stage 5.9 — Enterprise Design System & Experience Modernization
## Master Plan (Planning Document — v1, July 2026)

> **Status: DRAFT — awaiting owner review and approval. No implementation begins until this plan is approved.**
>
> Scope contract: Stage 5.9 introduces **zero new business features**. Every endpoint, permission, and data flow stays exactly as shipped in Stages 1–5. This is a UX/design modernization of the existing product across the Platform Owner portal, Company Admin portal, and the employee mobile app.
>
> Design bar: Salesforce Lightning, HubSpot, Dynamics, Linear, Notion, Atlassian, Apple — premium, modern, clean, professional, enterprise, consistent, fast, easy to use.

---

## Part 1 — Enterprise UX Audit (current state)

The audit covered all surfaces: both web portals (auth, CRM, pipeline, companies, contacts, documents, dashboards, Executive Intelligence, AI Command Center, workflow pages, OCR/capture, reports, settings) and the full mobile app.

### 1.1 Surface inventory

**Platform Owner portal (`/platform`)** — Dashboard, Companies, Users, Subscriptions, Analytics, AI Intelligence, Activity, Settings.

**Company Admin portal (`/admin`)** — 30+ pages: Dashboard, Contacts (+detail/new), Duplicates, Leads pipeline (+settings), Tags, Events (+detail), Documents, Scan Card, Notifications, Team, Teams, Departments, Directory, Org Hierarchy, Roles & Permissions, Reports, Executive Dashboard, AI Command Center, AI Insights, Sales Copilot, Workflow Intelligence, Executive Intelligence, Batch AI, AI Settings, Organization, Security, Subscription, Sessions, Profile, Settings.

**Auth / public** — Login, Forgot/Reset Password, Verify Email, Accept Invite, public digital card (`/c/:token`).

**Mobile (Expo)** — 5 tabs (Home, Capture, Contacts, Followups, More) + capture suite (camera single/rapid/batch, manual, NFC, QR), scan review, contacts/leads/pipeline/events/companies/tasks/meetings, AI assistant, workflow, executive, settings, sync/offline, digital card, my-numbers.

### 1.2 Findings — UX inconsistencies

| # | Finding | Evidence | Severity |
|---|---------|----------|----------|
| U1 | **Two incompatible table paradigms.** Leads uses a custom virtualized grid (`LeadsTable.tsx`, @tanstack/react-virtual, sticky headers, pinned columns, BulkBar); Contacts and Platform Companies use plain shadcn Table with no virtualization, no bulk actions, different selection patterns. | `pages/admin/leads/LeadsTable.tsx` vs `pages/admin/Contacts.tsx`, `pages/platform/Companies.tsx` | High |
| U2 | **Inconsistent form patterns.** `ContactNew.tsx` uses react-hook-form + Zod with inline validation; other pages (e.g. `AdminAiSettings.tsx`) use ad-hoc useState forms with divergent error/feedback behavior. Save/Cancel placement and separators vary page to page. | `ContactNew.tsx`, `AdminAiSettings.tsx` | High |
| U3 | **Three different empty-state styles** (dashed border box, plain table-row text, bespoke per-page) and two loading styles ("Loading..." text vs spinner). | `LeadsTable.tsx:429`, `Contacts.tsx:165`, `App.tsx` | Medium |
| U4 | **Duplicated status/badge logic.** Temperature styles hardcoded in Contacts, a separate `statusOf` map in LeadsTable, more per-page variants elsewhere — no single StatusBadge. | `Contacts.tsx` (`TEMPERATURE_STYLES`), `LeadsTable.tsx` | Medium |
| U5 | **Duplicated metric/stat card implementations** across Leads KPI cards and both portal dashboards. | `KpiCards.tsx`, admin/platform `Dashboard.tsx` | Medium |
| U6 | **Two advanced-search UIs** for near-identical use cases: Contacts uses a Dialog, Leads uses a Drawer, with different layouts. | `AdvancedSearch.tsx` vs `AdvancedFilters.tsx` | Medium |

### 1.3 Findings — Navigation & information architecture

| # | Finding | Evidence | Severity |
|---|---------|----------|----------|
| N1 | **Admin sidebar has 32+ items in one scrolling list.** Operational items (Contacts, Leads) sit next to configuration (Security, Subscription) and seven separate AI pages — severe cognitive load. | `AdminLayout.tsx` | Critical |
| N2 | **AI surface fragmentation**: AI Command Center, AI Insights, Sales Copilot, Workflow Intelligence, Executive Intelligence, Batch AI, and AI Settings are seven separate nav destinations with no hub. | `AdminLayout.tsx` | High |
| N3 | **No breadcrumbs / no global search or command palette** despite deep pages (event → member → report) and the `command` primitive being installed. | `components/ui/` | High |
| N4 | **Mobile "More" menu is an overflow dump** of 14+ items including primary features (Leads, Events, Meetings), while tab slots hold Followups. | `app/(tabs)/more.tsx` | High |
| N5 | **Mobile deep nesting**: event reports and member views are only reachable via events; no cross-links from contacts/leads. | `app/event/[id]/…` | Medium |
| N6 | **Dual mobile nav systems** (Liquid Glass NativeTabs for iOS 26+ vs ClassicTabLayout) must be manually kept in sync. | `app/(tabs)/_layout` | Medium |

### 1.4 Findings — Component & layout consistency

| # | Finding | Evidence | Severity |
|---|---------|----------|----------|
| C1 | **Brand colors as magic strings** (`BRAND.navy`, `BRAND.orange`, raw hex) rather than CSS-variable tokens, undermining dark mode and theming. | multiple web pages; mobile `ui.tsx`, `report.tsx`, `more.tsx` (`#22C55E`, `#EF4444`) | High |
| C2 | **Web dark mode is wired (`.dark` CSS variables) but has no user-facing toggle** and pages using magic colors would break in it. | `index.css`, `AdminSettings.tsx` | Medium |
| C3 | **Layout drift between portals**: AdminLayout uses `#F8F9FB` + `max-w-7xl`; PlatformLayout differs; page-level spacing alternates between `space-y-6` and `gap-4` conventions. | layouts + pages | Medium |
| C4 | **Missing enterprise primitives**: no shared `data-table`, standalone `combobox`, `date-range-picker`, or global command palette (55 shadcn primitives exist; these gaps force hand-rolling). | `components/ui/` inventory | High |
| C5 | **Mobile has no Card/ListRow/SecondaryButton primitives** — every list screen hand-rolls containers with padding 14–20px and varying radii; inputs styled per-screen (login vs ContactForm). | `components/ui.tsx`, `app/*.tsx` | High |
| C6 | **Mobile has no spacing/size tokens** — hardcoded `gap: 14`, `padding: 16`, font sizes 12/14/15.5/18/30; typography (FONT/Inter) is the only consistent token besides colors. | mobile screens | Medium |

### 1.5 Findings — Accessibility

| # | Finding | Evidence | Severity |
|---|---------|----------|----------|
| A1 | Inputs relying on placeholder-only labeling; missing `<Label>` associations on several web forms. | assorted admin pages | High |
| A2 | Virtualized leads grid has no keyboard navigation (row/cell focus model). | `LeadsTable.tsx` | High |
| A3 | Color-only status signaling (Hot/Warm/Cold, stage colors) with no shape/text redundancy for colorblind users. | `Contacts.tsx`, pipeline | Medium |
| A4 | Mobile `accessibilityLabel` coverage is sporadic (good: assistant, PinPad, ErrorFallback; missing: most list rows and icon buttons); muted text `#67707D` needs contrast verification. | mobile screens | Medium |
| A5 | No documented focus-management convention for dialogs/drawers; no skip-links; no reduced-motion support. | web-wide | Medium |

### 1.6 Findings — Performance

| # | Finding | Evidence | Severity |
|---|---------|----------|----------|
| P1 | Contacts (and other non-leads lists) render up to 50 rows unvirtualized with no pagination strategy for growth. | `Contacts.tsx` | High |
| P2 | Global `ProtectedRoute` causes a full-page "Loading..." flash on every route change. | `App.tsx` | Medium |
| P3 | Mobile screens using `ScrollView` + `.map()` for growable lists (contact detail activity, pipeline detail, tasks) — frame drops at 50+ items. | `contact/[id].tsx`, `tasks.tsx` | Medium |
| P4 | No skeleton loading anywhere (skeleton primitive exists, unused) — perceived performance suffers. | web-wide | Low |

### 1.7 What is already strong (preserve, don't regress)

- Web token foundation: HSL CSS variables, semantic tokens, `.dark` class, Inter, radius scale (`index.css`).
- 55 shadcn/ui primitives already installed; sidebar/command/breadcrumb/skeleton exist but are underused.
- Leads virtualized grid is the best-in-repo data-grid and the seed for the shared DataTable.
- Mobile: semantic `useColors` theming with light/dark/system, centralized FONT, shared Loading/Empty/ErrorState, excellent EN/AR + RTL system (`useLocale` with rowDirection/textAlign/mirror), pull-to-refresh everywhere, expo-image caching, offline queue with sync screen.
- Mobile keyboard handling (KeyboardAwareScrollView + compat wrapper) is solid.

---

## Part 2 — Stage 5.9 Master Plan

### 2.1 Guiding principles

1. **No business-feature changes.** API contracts, permissions, and data flows are frozen; only presentation, IA, and interaction change.
2. **Token-first.** Every color, space, radius, type size flows from one token source per platform (CSS variables on web, a theme object on mobile) — no raw hex/px in feature code.
3. **One pattern per problem.** One data grid, one form system, one badge, one metric card, one empty/loading/error vocabulary — everywhere, in both portals and mobile.
4. **Migrate, don't rewrite.** Screens are re-skinned onto the new system incrementally; the app stays shippable after every phase.
5. **Accessibility and RTL are acceptance criteria, not afterthoughts** (WCAG 2.1 AA targets; EN/AR parity preserved on mobile).
6. **Advisory-AI presentation stays honest** — provenance badges, confidence, and deterministic-vs-AI distinction are elevated as first-class design-system components.

### 2.2 Phase plan

**Phase 0 — Design language definition (foundation, no code migration)**
- Finalize the visual identity within current branding (navy + orange "Powered by Elite Marcom"): color ramps (primary/neutral/semantic incl. AA-checked status colors with light+dark values), Inter type scale (display→caption), 4px spacing grid, radius/elevation/motion tokens, icon standard (Lucide web / SVG Feather mobile).
- Deliverables: token spec (`lib/design-tokens` proposal), web `index.css` variable extension, mobile `constants/colors.ts` + new `constants/tokens.ts` spec, dark-mode palette for web.

**Phase 1 — Core component library (web)**
- Build the enterprise layer on top of shadcn: **DataTable** (generalized from LeadsTable: virtualization, sticky/pinned, sorting, column visibility, bulk bar, keyboard nav, a11y), **FormSystem** (react-hook-form + Zod wrapper as the single form pattern), **StatusBadge**, **MetricCard**, **PageHeader** (title/actions/breadcrumbs), **FilterBar** (unified search/filter replacing the Dialog/Drawer split), **EmptyState/ErrorState/Skeleton** vocabulary, **Combobox**, **DateRangePicker**, **CommandPalette** (global ⌘K nav + entity search using existing endpoints only).
- Deliverable: component library + usage docs; no page migrations yet beyond a pilot page pair (Contacts + Platform Companies) to validate the DataTable/FormSystem.

**Phase 2 — Navigation & IA modernization (web)**
- Admin sidebar regrouped into collapsible sections: **Workspace** (Dashboard), **CRM** (Contacts, Companies, Duplicates, Tags), **Pipeline** (Leads, Pipeline Settings), **Capture** (Scan, Batch), **Events & Docs**, **AI Intelligence hub** (one entry with an in-page hub for Command Center, Insights, Copilot, Workflow, Executive Intelligence, Batch AI), **Analytics** (Reports, Executive Dashboard), **Organization** (Team, Departments, Teams, Directory, Hierarchy, Roles), **Settings** (Organization, Security, Subscription, Sessions, AI Settings, Profile). Same regrouping logic for the Platform portal.
- Breadcrumbs on all nested pages; route-level loading via skeletons (kills the ProtectedRoute flash); user-facing dark-mode toggle.
- All existing URLs preserved (redirects only if a route must move).

**Phase 3 — Web screen modernization (both portals)**
- Migrate every page onto the Phase-1 system in this order: CRM (Contacts/Companies/Duplicates/Tags) → Pipeline (Kanban polish + DataTable views) → Dashboards (admin, platform, executive) → AI suite (hub + provenance components) → Capture/OCR review → Events/Documents → Reports → Org/Settings/Auth.
- Per-page acceptance: tokens only, shared components only, empty/loading/error states, keyboard + screen-reader pass, dark mode verified, no behavior change (existing tests stay green).

**Phase 4 — Mobile modernization**
- Token layer (`tokens.ts`: spacing/type/radius) + new primitives (Card, ListRow, SecondaryButton/IconButton, Input, Section) in `components/ui`.
- IA: rebalance tabs (promote Leads; Followups merges into a combined work queue or stays per owner preference — decision point below), redesign More into grouped sections, add cross-links to deep screens.
- Convert growable `ScrollView+map` lists to FlatList; sweep `accessibilityLabel`s; verify contrast; unify hardcoded status colors to tokens; keep EN/AR + RTL parity as a per-screen acceptance criterion.
- Screen order: Home → Capture suite/scan review → Contacts → Leads/Pipeline → Events → AI screens → Settings/More.

**Phase 5 — Polish, accessibility & performance hardening**
- Micro-interactions (hover/press states, transitions, optimistic UI affordances, reduced-motion support), full WCAG AA audit pass, skeleton coverage, bundle/route-splitting review, final cross-portal + mobile consistency QA, updated docs (design-system usage guide) and full regression gate (554+ tests) green.

### 2.3 Sequencing & dependencies

Phase 0 → 1 → 2 are strictly sequential (tokens → components → shell). Phase 3 and Phase 4 can run in parallel after Phase 2 (web pages and mobile don't share code). Phase 5 is last. Each phase ends in a reviewable checkpoint; the product remains fully functional at every checkpoint.

### 2.4 Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Regression while re-skinning (RBAC gates, tenant scoping, provenance honesty) | No logic changes in migration PRs; full test gate after every phase; provenance/permission behavior is an explicit acceptance item. |
| DataTable generalization breaks the tuned Leads grid | Leads migrates last among tables; virtualization benchmarks before/after. |
| Dark-mode fallout from magic colors | Phase 0 token sweep includes a "no raw hex" lint rule before page migration starts. |
| Mobile dual-nav (Liquid Glass vs Classic) drift | Single nav config consumed by both layouts. |
| RTL/i18n regressions | Per-screen EN+AR screenshot check in mobile acceptance. |
| Scope creep into new features | Frozen-contract rule: any change touching OpenAPI or permissions is rejected in Stage 5.9. |

### 2.5 Decision points for the owner (answer during plan review)

1. **Mobile tab lineup** — promote Leads into the tab bar (replacing or merging Followups into a "Work" queue), or keep the current 5 tabs and only reorganize More?
2. **Dark mode scope** — ship the web dark-mode toggle in 5.9 (recommended; foundation exists) or defer to keep 5.9 shorter?
3. **AI hub** — consolidate the seven AI pages under one "AI Intelligence" hub entry (recommended) or keep separate nav items with grouping only?
4. **Command palette (⌘K)** — include global navigation + entity search (uses only existing search endpoints) or defer?

### 2.6 Definition of done (Stage 5.9)

- 100% of web pages (both portals + auth) and mobile screens use design-system tokens and shared components; zero raw hex/ad-hoc spacing in feature code.
- One DataTable, one form system, one badge/card/empty/loading/error vocabulary across the product.
- Regrouped navigation with breadcrumbs (web) and rebalanced tabs/More (mobile).
- WCAG 2.1 AA pass on core flows; keyboard navigation on all tables/forms/dialogs; EN/AR + RTL parity intact.
- Dark mode functional on web (if approved) and unchanged on mobile.
- No API/permission/behavior changes; full regression suite green; performance equal or better (virtualized lists, no route-change flash, skeleton loading).

---

*Next step: owner reviews this plan (including §2.5 decision points). Upon approval, Stage 5.9 implementation begins at Phase 0. After Stage 5.9 → Stage 5.5 (Enterprise Collaboration & Communication Center) → Stage 6.*
