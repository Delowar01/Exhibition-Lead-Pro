# Beez × Elite Marcom — Seamless Saudi Arabia 2026 deck

`presentation.html` at the repository root is a **self-contained** 1920×1080 HTML
deck: 16 slides, every asset and the typeface inlined as base64, no network
requests. It is presented live from a laptop and emailed as a PDF afterwards.

## Building

```bash
node deck/build.mjs      # deck/src/presentation.src.html + deck/assets/ -> presentation.html
```

The source template carries `{{asset:<file>}}` tokens; the build replaces each
with a base64 data URI from `deck/assets/`. **Edit the source, never
`presentation.html` directly** — the next build overwrites it.

Every asset is referenced exactly once, so swapping a logo or a photo is one file
drop in `deck/assets/` plus a rebuild.

## Presenting

| Key | Action |
|---|---|
| `→` `PageDown` `Space` `Enter` | Next slide |
| `←` `PageUp` `Backspace` | Previous slide |
| `Home` / `End` | First / last slide |
| `S` | Speaker notes |
| `O` | Slide overview (click a thumbnail to jump) |
| `B` or `.` | Black the screen |
| `F` | Full screen |

Swipe left/right works on touch, and tapping anywhere reveals the nav bar for a
few seconds (it is hidden while presenting).

## PDF export

Open the file in Chrome and print (`Ctrl/Cmd + P`) with **Background graphics**
on. `@page { size: 1920px 1080px }` gives 16 landscape pages at exactly 16:9,
one slide per page. The result is roughly 8 MB, small enough to email.

Two things keep that size down and should stay as they are:

- **Photographs are JPEG, not WebP.** Chrome copies JPEG streams straight into
  the PDF but re-encodes WebP losslessly, which multiplied the export to ~19 MB.
  The floor plan and the transparent stand render stay WebP — the first is line
  art that needs the sharpness, the second needs an alpha channel.
- The `@media print` block flattens the large neutral gradient washes to their
  average colour. Chrome rasterises every gradient layer into the PDF; flattening
  them is invisible at print scale and saved another ~8 MB. Brand accents are
  left alone.

## Optional figures: `DECK_CONFIG`

The deck carries **no placeholders**. Every slide reads as finished copy with the
figures that are actually known, and states the process, the commitment or the
dependency wherever a figure is not. Nothing is ever left blank.

Four figures can be supplied later to upgrade that copy to hard numbers. They
live in one commented constant at the top of the `<script>` in
`deck/src/presentation.src.html`:

```js
var DECK_CONFIG = {
  buildRatePerSqm:   null,   // { low: 1400, high: 2200, currency: 'SAR' }
  leadTimes:         null,   // { booking, payment, design, approval,
                             //   fabrication, shipping, installation, dismantle }
  proof: { yearsOperating: null, standsDelivered: null,
           marketsCovered: null, namedClients: null }
};
```

| Value | null (default) | supplied |
|---|---|---|
| `buildRatePerSqm` | Slide 10 block 2 describes what the build quotation covers and commits to a firm figure on design approval; block 3 rows read "Organizer … + build" | A per-sqm band appears in block 2, and each block-3 row gains its computed build range |
| `leadTimes` | Slide 11 steps carry their description only | A lead-time chip appears above each step's description |
| `proof.*` | Slide 14 shows a capability strip built from facts already established in the deck | The numeric proof strip replaces it, showing only the values supplied |

Rebuild after editing. Both states are designed to look finished — a missing
value never produces an empty chip.

The four KPI figures on slide 5 (14K / 400 / 300+ / 46%) are organizer numbers
carrying a source line, not config. They sit in one contiguous block marked with
an `EDIT POINT` comment — change the value inside each `<span class="kpi-val">`
and nothing else has to move.

## Slide 11 counts down on its own

The weeks-remaining anchor on the timeline slide is computed from the current
date against 9 November 2026 every time the deck opens, so it cannot go stale.
After the show date it simply does not render, and the slide still reads
complete.

## Palette

Driven entirely from `:root`. `--orange: #E56C25`, `--navy: #02004C`; every other
colour derives from those two. Changing either updates the whole deck.

## Content rules baked into the deck

- Money is always shown in USD **and** SAR at the 3.75 peg.
- No organizer branding anywhere. The floor plan is the one permitted organizer
  asset and is cropped to the plan itself, with the event logo and sponsor strip
  removed; its legend is redrawn in Elite Marcom's own styling.
- Every slide from 4 onward carries a Beez-specific reference — cold chain,
  temperature-controlled fleet, 4PL, real-time tracking, or a served industry.
- Entrance animations only. Nothing loops while the presenter is talking.
- **No placeholders.** Where a figure is not yet known, the copy states the
  process, the commitment or the dependency instead of leaving a gap. Numbers are
  never invented to fill space.

## Typeface

Inter (Rasmus Andersson, SIL Open Font License 1.1), Latin subset of the variable
font (opsz 14–32, wght 100–900), embedded as WOFF2 so the deck renders identically
on a machine that does not have Inter installed.
