# Motion

## Tokens (web — `index.css`)

| Token | Value | Use |
|---|---|---|
| `--motion-fast` | 120ms | Hovers, toggles, small state changes |
| `--motion-base` | 180ms | Default transitions (menus, popovers, fades) |
| `--motion-slow` | 280ms | Drawers, dialogs, larger movements |
| `--motion-ease` | cubic-bezier(0.2, 0, 0, 1) | Default easing |
| `--motion-ease-out` | cubic-bezier(0, 0, 0.2, 1) | Exit / dismiss easing |

Mobile: `constants/tokens.ts` → `MOTION` (`fast` 120 / `base` 180 / `slow` 280) — the same canonical set.

## Rules

- Motion communicates state change; it never decorates. No looping/ambient animation in the CRM.
- Durations come from tokens — nothing longer than `slow` for interaction feedback.
- Animate `transform`/`opacity` only (compositor-friendly); avoid animating layout properties.

## Reduced motion

`index.css` contains a global `@media (prefers-reduced-motion: reduce)` block that collapses animations/transitions to near-zero. Any custom animation must survive this (i.e., the end state must be correct without the animation).
