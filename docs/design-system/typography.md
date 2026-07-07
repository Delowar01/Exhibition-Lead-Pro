# Typography

One typeface (Inter), one scale, used identically in both portals and (with the mobile scale) in the app.

## Web scale

| Level | Classes / helper | Use |
|---|---|---|
| Display | `text-4xl font-bold tracking-tight` / `<Display>` | Marketing/empty hero moments (rare) |
| Page title | `text-2xl font-bold tracking-tight` / `PageHeader` | One per page, always via `PageHeader` |
| Section title | `text-lg font-semibold` / `<SectionTitle>` | Card and section headings |
| Subsection | `text-sm font-semibold` / `<SubsectionTitle>` | Dense group headings |
| Body | `text-sm` / `<Body>` | Default reading size |
| Caption | `text-xs text-muted-foreground` / `<Caption>` | Meta, hints, timestamps |
| Overline | `<OverlineLabel>` | Uppercase 11px group labels |
| KPI | `text-3xl font-bold tabular-nums tracking-tight` / `<KpiNumber>` | Metric values |

Helpers live in `artifacts/web-app/src/components/ds/Typography.tsx`. Prefer them for headings/KPIs; plain `text-sm` body copy inside components is fine.

## Rules

- **Numbers in tables/KPIs are always `tabular-nums`** so columns align and values don't jitter on update.
- One `h1` per page (rendered by `PageHeader`); heading levels never skip.
- Never convey emphasis with color alone — pair with weight.

## Mobile scale

`constants/tokens.ts` → `TYPE`: `display` 28/34, `title` 22/28, `heading` 17/22, `body` 15/21, `caption` 13/18, `micro` 11/14. Pair with the `FONT` family map in `components/ui.tsx` (Inter 400/500/600/700).
