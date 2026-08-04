---
name: Arabic test-image rendering (sharp/librsvg)
description: How to render Arabic/bilingual card fixtures that actually show Arabic text, and the RTL attribute trap that silently blanks it.
---

# RTL attribute trap
In SVG rendered through sharp/librsvg, combining `text-anchor="end"` with `direction="rtl"` pushes Arabic text partially OFF-CANVAS (double right-alignment). The model then honestly returns null for the Arabic fields — it looks like an OCR bug but is a fixture bug. Use `text-anchor="end"` ALONE for right-aligned Arabic; shaping/joining works fine without `direction`.
**How to apply:** ALWAYS view the rendered fixture image (ReadFile on the .jpg) before blaming the OCR pipeline for missing fields.

# Getting Arabic fonts into the environment
- Nix `noto-fonts` install did NOT land in fontconfig here (fc-list stayed at 8 DejaVu faces).
- Working approach: download variable TTFs from google/fonts raw GitHub into `~/.fonts`, then `fc-cache -f`:
  `https://raw.githubusercontent.com/google/fonts/main/ofl/notosansarabic/NotoSansArabic%5Bwdth%2Cwght%5D.ttf` (same pattern for `notosans`).
- The `notofonts/<script>` repo raw paths 404 and return HTML — check downloads with `file *.ttf` (an "HTML document" result means the URL was wrong).
