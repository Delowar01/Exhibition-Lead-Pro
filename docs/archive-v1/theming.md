# Theming (light / dark / system)

## Web

Engine: `artifacts/web-app/src/contexts/ThemeContext.tsx`, mounted in `main.tsx` around the whole app.

- Preferences: `light` | `dark` | `system` (default `system`).
- Persistence: `localStorage` key `csp_theme`.
- `system` tracks `prefers-color-scheme` live via `matchMedia` — changing the OS theme retints the app without reload.
- Applying: the provider toggles the `.dark` class on `<html>`; every token has a `.dark` value in `index.css`, so components need **zero** theme-conditional code.
- UI: `<ThemeToggle />` (`components/ds`) — sun/moon dropdown with Light/Dark/System; mounted in both portal sidebars.

### Rules

- Never branch on theme in a component (`isDark ? … : …`). If something must differ per theme, it needs a token.
- Never use `dark:` Tailwind variants for colors that should be tokens — add the token instead.
- Test any new surface in both themes via the showcase page before shipping.

## Mobile

`useColors()` already resolves the semantic palette from `constants/colors.ts` per the user's theme preference. Same rule: components consume palette keys, never literal colors.
