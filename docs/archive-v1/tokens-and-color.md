# Tokens & Color

All color in the product flows through semantic CSS variables defined in `artifacts/web-app/src/index.css` (`:root` = light, `.dark` = dark) and mirrored for mobile in `artifacts/mobile/constants/colors.ts` (consumed via `useColors()`).

## Why semantic tokens

- **One change, everywhere:** rebranding or contrast fixes are single-file edits.
- **Dark mode for free:** every token has a light and a dark value; components never branch on theme.
- **No drift:** hardcoded hex values (`#F8F9FB`, `#22C55E`) rot silently — tokens can't.

## Core surface tokens (existing)

`background`, `foreground`, `card`, `card-foreground`, `card-border`, `popover`, `primary`, `secondary`, `muted`, `muted-foreground`, `accent`, `border`, `input`, `ring`, plus the `sidebar-*` family.

## Stage 5.9 additions

| Token | Purpose |
|---|---|
| `success`, `success-foreground`, `success-soft` | Positive states: won, active, healthy |
| `warning`, `warning-foreground`, `warning-soft` | Caution: pending, expiring, degraded |
| `info`, `info-foreground`, `info-soft` | Neutral-informational: in review, scheduled |
| `destructive-soft` | Soft background for error surfaces (pairs with existing `destructive`) |
| `primary-soft` | Soft brand-orange background for highlighted/selected states |
| `brand-navy`, `brand-navy-soft` | Brand navy (`#151348` heritage) as a token — replaces the magic hex constants |

`*-soft` tokens are backgrounds for badges/callouts; the base token is the text/icon color on top of them. This pairing meets contrast requirements in both themes.

## Usage rules

1. **Never write a raw hex/hsl value in feature code.** Use Tailwind utilities backed by tokens: `bg-success-soft text-success`, `border-border`, `bg-background`.
2. **Status is tone, not color:** use `StatusBadge` with a `tone` prop rather than composing colors per page.
3. Charts may use an explicit categorical palette, but UI chrome around them uses tokens.
4. Mobile: use `useColors()` keys only; non-color values come from `constants/tokens.ts`.

## Known debt (later phases)

`components/pipeline/utils.tsx` (web) and the status maps in `components/ui.tsx` (mobile) still contain literal hex palettes. They are scheduled for token migration in the screen-migration phases; Phase 1's rule is that **no new** magic values are introduced.
