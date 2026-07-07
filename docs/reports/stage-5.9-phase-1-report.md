# Stage 5.9 — Phase 1 Report: Enterprise Design Foundation

**Date:** July 2026 · **Scope:** foundation only — no business logic, API, RBAC, or data changes. Phase 2 has NOT been started, per directive.

## What was delivered

### 1. Semantic token expansion (web)
`artifacts/web-app/src/index.css` — added `success` / `warning` / `info` (each with `-foreground` and `-soft`), `destructive-soft`, `primary-soft`, and `brand-navy(-soft)` tokens with tuned **light and dark** values, plus motion tokens (`--motion-fast/base/slow/ease`) and a global `prefers-reduced-motion` guard.

- **Why:** status colors and the brand navy were hardcoded hex values scattered across pages — impossible to retheme, inconsistent between screens, and invisible to dark mode.
- **Benefits:** one-file rebranding/contrast fixes; dark mode works on every new surface with zero component code; the `x`-on-`x-soft` pairing is contrast-checked (a11y) in both themes.

### 2. Theme engine — light / dark / system (web)
`src/contexts/ThemeContext.tsx` + `<ThemeToggle>` mounted in both portal sidebars. Preference persists in `localStorage` (`csp_theme`); `system` tracks the OS live via `matchMedia`; applied by toggling `.dark` on `<html>`.

- **Why:** enterprise users expect dark mode (Salesforce, Linear, Notion all ship it); the token architecture made it nearly free.
- **UX/perf impact:** no reload, no flash of wrong theme, no per-component theme branching.

### 3. Enterprise component layer (web)
New `src/components/ds/` (barrel `@/components/ds`): `PageHeader` (breadcrumbs + single h1 + action slot), `MetricCard`, `StatusBadge` (6 tones, colorblind-safe dot), `EmptyState` / `ErrorState` / `TableSkeleton` / `CardGridSkeleton`, typography helpers, `ThemeToggle`.

- **Why:** the audit found duplicated stat-cards, per-page badge styling, and inconsistent empty/error/loading treatments.
- **Benefits:** consistency by construction; a11y is baked in once (`role="alert"`, `aria-busy`, breadcrumb semantics, labeled controls); skeletons replace spinners for better perceived performance.

### 4. Design-system showcase page (web)
`/admin/design-system` — living reference rendering all tokens, the type scale, and every ds component in both themes (with a skeleton toggle). Serves as before/after evidence and the visual-regression baseline for later phases.

### 5. Mobile foundation
`constants/tokens.ts` — `SPACING` (4pt grid), `TYPE` scale, `RADIUS`, `ICON`, `MOTION`, `TOUCH_TARGET` (44pt). New primitives in `components/ui.tsx`: `Card`, `ListRow`, `SecondaryButton`, `IconButton` (44pt, required a11y label), `Input` (labeled + error state). All consume `useColors()` + tokens — no magic numbers.

- **Why:** mobile had semantic colors but no spacing/type tokens and no list/card/input primitives, so every screen re-invented them.

### 6. Documentation
`docs/design-system/` — README + 7 guides (tokens & color, typography, components, theming, motion, responsive & RTL, accessibility). Establishes the Phase-1 governing rule: **no new magic values; new patterns enter the design system before feature code.**

## Files modified / added

- **Modified:** `web-app/src/index.css`, `main.tsx`, `App.tsx`, `components/layouts/AdminLayout.tsx` (+ bg token fix), `components/layouts/PlatformLayout.tsx`, `mobile/components/ui.tsx`
- **Added:** `web-app/src/contexts/ThemeContext.tsx`, `web-app/src/components/ds/*` (7 files), `web-app/src/pages/admin/DesignSystem.tsx`, `mobile/constants/tokens.ts`, `docs/design-system/*` (8 docs), this report

## Verification

- `pnpm --filter @workspace/web-app run typecheck` — clean
- `pnpm --filter @workspace/mobile run typecheck` — clean
- Playwright e2e: login → showcase renders (tokens, metric cards, badges, states), skeleton toggle, dark-mode switch, persistence across reload, switch back to light — all passed
- Architect review findings addressed: pre-paint theme boot script added to `index.html` (no light-mode flash on stored-dark/system-dark cold loads); motion tokens aligned to one canonical set (120/180/280ms) across web CSS, mobile tokens, and docs
- No API, schema, RBAC, or business-logic files touched

## Known debt carried into later phases (intentional)

- Legacy hex palettes in `web-app/src/components/pipeline/utils.tsx` and mobile status maps — migrate during screen-migration phases.
- Existing screens still use ad-hoc headers/badges/stat-cards; migration to the ds layer is Phases 2+.
- Missing enterprise primitives (data-table, combobox, date-range picker, command palette) are scheduled per the master plan.
