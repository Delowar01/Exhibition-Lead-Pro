---
name: RN sticky header in a padded ScrollView
description: How to make a mid-content sticky bar (stickyHeaderIndices) work; padding and safe-area placement traps.
---

To pin a bar (e.g. quick actions) below a scrolled-away header with `stickyHeaderIndices`:

- **Never leave horizontal/top padding on `contentContainerStyle`** — a padded scroll container mis-positions the sticky child and lets content peek around it. Move padding into per-section wrapper Views: `[0]` padded header wrapper, `[1]` the sticky wrapper, `[2]` padded content wrapper, and set `stickyHeaderIndices={[1]}`.
- The sticky wrapper needs an **opaque background** (theme background color) + bottom hairline border, or scrolled content shows through it.
- Eat the top safe-area inset on a **parent View around the ScrollView** (`paddingTop: insets.top`), not inside the scroll content — otherwise the sticky bar pins into the status bar area.
- Conditional tab-content fragments can live inside wrapper `[2]` unchanged; only direct-children order matters.

**Why:** Batch 8 round 2 contact-workspace sticky bar — the naive approach (keep `padding: 20` on contentContainerStyle) produced misaligned pinning; the 3-wrapper restructure verified clean via scroll screenshots at 360/390/412, LTR+RTL.
