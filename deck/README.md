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
  them is invisible at print scale and saved another ~8 MB. Brand accents and the
  `«CONFIRM»` hatch are left alone.

## Before the meeting: fill in the placeholders

Anything rendered with an orange dashed hatch is a `«CONFIRM»` placeholder and
must be replaced with a real figure. Search the source for `class="confirm"`.

| Slide | Placeholder |
|---|---|
| 5 — Audience & return | The four funnel ratios: footfall past the zone, stop rate, qualification rate, cost per qualified lead |
| 7 — Floor plan | Final block size once the organizer confirms subdivision |
| 9 — Exhibition package | Which pass tier (5–20) a 36 sqm stand falls into |
| 10 — Cost | The per-sqm build rate band, and the three total participation figures |
| 11 — Timeline | Every deadline date and duration |
| 14 — Capability | Years operating, stands delivered, markets, named clients, KSA credentials |
| 15 — Decision | Dates against the four Elite Marcom next actions |

The four KPI figures on slide 5 (14K / 400 / 300+ / 46%) are organizer numbers
carrying a source line, not placeholders. They sit in one contiguous block marked
with an `EDIT POINT` comment — change the value inside each `<span class="kpi-val">`
and nothing else has to move.

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

## Typeface

Inter (Rasmus Andersson, SIL Open Font License 1.1), Latin subset of the variable
font (opsz 14–32, wght 100–900), embedded as WOFF2 so the deck renders identically
on a machine that does not have Inter installed.
