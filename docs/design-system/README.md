# Enterprise Design System (Stage 5.9)

The single source of truth for how Card Scanner Pro looks and behaves — web (both portals) and mobile.

**Live reference:** the internal showcase page at `/admin/design-system` (web app) renders every token and component in light and dark mode.

## Guides

| Guide | Covers |
|---|---|
| [Tokens & color](tokens-and-color.md) | Semantic color tokens, soft variants, brand colors, light/dark values, usage rules |
| [Typography](typography.md) | Type scale, weights, hierarchy helpers, tabular numbers |
| [Components](components.md) | The `components/ds` layer (web) + Stage 5.9 mobile primitives, when to use what |
| [Theming](theming.md) | Light/dark/system theme engine, `ThemeProvider`, persistence, adding themed styles |
| [Motion](motion.md) | Duration/easing tokens, reduced-motion policy |
| [Responsive & RTL](responsive-and-rtl.md) | Breakpoints, layout grid, mobile spacing grid, RTL rules |
| [Accessibility](accessibility.md) | Contrast, focus, labels, touch targets, color-independence |

## The one rule

**No new magic values.** Feature code must use semantic tokens (`bg-success-soft`, `text-muted-foreground`, `SPACING.lg`) and the shared component layer (`components/ds` on web, `components/ui.tsx` primitives on mobile). New visual patterns are added to the design system first, then consumed — never invented inline.

## Status

Phase 1 (foundation) is complete: tokens, theme engine, typography scale, web component layer + showcase, mobile tokens + primitives, these docs. Existing screens are migrated in later Stage 5.9 phases — Phase 1 adds the foundation without rewriting screens.
