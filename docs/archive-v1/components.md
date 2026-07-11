# Component Layer

Two tiers on web:

1. **Primitives** — shadcn/ui components in `artifacts/web-app/src/components/ui/` (button, input, dialog, table, tabs, dropdown, …). Low-level building blocks.
2. **Design-system components** — `artifacts/web-app/src/components/ds/` (barrel: `@/components/ds`). Opinionated, product-level patterns. **Feature code should reach for these first.**

## Web `components/ds`

| Component | Replaces | Notes |
|---|---|---|
| `PageHeader` | Ad-hoc per-page `<h1>` blocks | Title + description + breadcrumbs + action slot; guarantees one consistent title band and a single `h1` |
| `MetricCard` | Duplicated stat-card implementations | Label, value, optional delta (▲/▼ with success/destructive color), icon, footer |
| `StatusBadge` | Per-page badge styling | Six tones (`success/warning/info/destructive/primary/neutral`), leading dot for color-independence |
| `EmptyState` / `ErrorState` | Inconsistent "no data" / error markup | Standard icon + title + description + action pattern; `ErrorState` sets `role="alert"` |
| `TableSkeleton` / `CardGridSkeleton` | Spinners / blank flashes | Shape-matched loading placeholders (perceived performance) |
| Typography helpers | Ad-hoc heading classes | See [typography.md](typography.md) |
| `ThemeToggle` | — | Light/dark/system switcher (default + sidebar variants) |

**Adding a new pattern:** if a visual pattern is needed on 2+ screens, add it to `components/ds` (with JSDoc + showcase entry) before using it. Never fork a copy into a page.

## Mobile primitives (`components/ui.tsx`)

Existing: `Avatar`, `Badge`, `PrimaryButton`, `LoadingState`, `EmptyState`, `ErrorState`.

Stage 5.9 additions: `Card` (standard elevated surface), `ListRow` (icon + title/subtitle + right slot + chevron, ≥44pt), `SecondaryButton` (outlined, optional destructive), `IconButton` (44pt target, required a11y label), `Input` (labeled, error state, token-driven).

All use `useColors()` + `constants/tokens.ts` — no magic numbers.

## Showcase

`/admin/design-system` (route in `App.tsx`, page: `pages/admin/DesignSystem.tsx`) renders every token/component in both themes and doubles as the visual regression reference.
