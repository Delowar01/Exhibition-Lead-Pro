# Responsive & RTL

## Web breakpoints (Tailwind defaults)

| Prefix | Min-width | Target |
|---|---|---|
| (none) | 0 | Phones |
| `sm` | 640px | Large phones / small tablets |
| `md` | 768px | Tablets |
| `lg` | 1024px | Laptops — sidebar layouts assume ≥ this |
| `xl` | 1280px | Desktops (`max-w-7xl` content cap) |

## Layout system

- Portal shells: fixed sidebar + `max-w-7xl mx-auto p-8` content column.
- Card grids: `grid gap-4 sm:grid-cols-2 lg:grid-cols-4` (KPI rows) or `lg:grid-cols-2` (panel pairs).
- Spacing rhythm: Tailwind's 4px grid — sections `space-y-10`/`space-y-6`, in-card `gap-3`/`gap-4`, never arbitrary pixel values.
- Tables: wrap in a card with `overflow-hidden` (horizontal scroll on narrow screens rather than squashing columns).

## Mobile spacing grid

`constants/tokens.ts` → `SPACING` (4/8/12/16/20/24/32) — the same 4pt grid as web. Screen padding `lg` (16), card padding `lg`, item gaps `sm`–`md`. `TOUCH_TARGET` = 44pt minimum for anything tappable.

## RTL (Arabic)

- Mobile is fully bilingual EN/AR with JS-driven RTL (see `mobile-i18n` conventions): use `start`/`end` style properties and flexbox direction, never hardcoded `left`/`right` for layout.
- Web: use logical utilities (`ms-*`, `me-*`, `ps-*`, `pe-*`, `text-start`) in new code so an RTL web locale remains achievable; directional icons (chevrons, arrows) must be chosen semantically.
