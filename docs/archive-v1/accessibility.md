# Accessibility

Baseline: WCAG 2.1 AA.

## Contrast

- All token pairs (`x` on `x-soft`, `foreground` on `background`, etc.) are chosen to meet 4.5:1 for text in both themes.
- `muted-foreground` is for secondary text only — never for essential values or numbers.

## Never color alone

Status must always carry a second signal: `StatusBadge` includes a leading dot + text label; `MetricCard` deltas pair color with ▲/▼ icons and a sign.

## Focus & keyboard

- Every interactive element is a real `<button>`/`<a>`/input (shadcn primitives already are) — no clickable `div`s.
- Focus rings come from the `--ring` token; never `outline-none` without a replacement.
- Dialogs/drawers/popovers use the shadcn primitives, which trap focus and restore it on close.

## Labels & semantics

- Icon-only controls require `aria-label` (web) / `accessibilityLabel` (mobile — `IconButton` makes it a required prop).
- Inputs always get a visible `<Label>`; placeholders are hints, never the only identifier. Hint/error text is linked via `aria-describedby`.
- One `h1` per page (via `PageHeader`); breadcrumbs use `nav[aria-label="Breadcrumb"]` + `aria-current="page"`.
- Loading regions set `aria-busy`; inline errors use `role="alert"`.

## Touch targets (mobile)

Minimum 44×44pt (`TOUCH_TARGET` token). `ListRow`, `IconButton`, `Input`, and both buttons already comply.

## Reduced motion

Honored globally — see [motion.md](motion.md).
