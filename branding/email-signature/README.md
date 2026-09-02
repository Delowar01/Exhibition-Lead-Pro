# Elite Marcom — animated HTML email signature

Signature for **Mohammad Delowar Hossain, Chief Operating Officer**.
Deep-navy card, gold hairlines, rotating gold photo ring, shimmering rule,
staggered reveal, icon hover lift.

| File | Purpose |
| --- | --- |
| `elite-marcom-signature.html` | Production signature. Images load from `https://www.elitemarcom.com/signature/`. |
| `elite-marcom-signature-embedded.html` | Same signature with every image embedded as base64. Opens complete anywhere; installs directly in Outlook desktop and Apple Mail. Gmail strips embedded images, so use the hosted file there. |
| `preview.html` | Open in a browser: live animated preview, copy buttons, install steps per client. |
| `build.js` | Generator. Brand colours, person details, links and the asset URL live here. `node build.js` rewrites everything above and re-renders the icon PNGs. |
| `glyphs.json`, `preview-template.html` | Icon paths and the preview page shell used by the builder. |
| `assets/` | Icon PNGs (72 px social discs, 32 px contact glyphs) with SVG sources. Put `photo.jpg` and `logo.png` here. |

## Add the photo and logo

1. Save the headshot as `assets/photo.jpg` (square crop, at least 240 × 240 px).
2. Save the logo as `assets/logo.png` (transparent, light or gold version for the navy band, about 420 × 140 px).
3. Match the colours: open `build.js`, set the `BRAND` values to the logo's colours.
4. Run `node build.js`. The embedded file, the preview and the icons now carry the photo, the logo and the new colours.

Until `logo.png` exists the band shows a live-text wordmark, so the signature is never blank.

## Host the images (for Gmail and the hosted file)

Upload `assets/*.png` plus `photo.jpg` and `logo.png` to
`https://www.elitemarcom.com/signature/`, or set `ASSET_BASE` in `build.js`
to any public folder and rebuild.

## Install

Open `preview.html` in a desktop browser and use its copy buttons.

- **Gmail**: *Copy rendered* → Settings → See all settings → General →
  Signature → Create new → paste → set as default → Save changes. Needs the
  hosted images.
- **Outlook (web / new desktop)**: *Copy rendered* → Settings → Accounts →
  Signatures → New → paste → Save. Classic Outlook for Windows accepts the
  embedded file pasted from a browser.
- **Apple Mail**: Mail → Settings → Signatures → add → untick *Always match my
  default message font* → paste. For the full animation, put the *Copy HTML*
  output into the signature's `.mailsignature` file under
  `~/Library/Mail/V10/MailData/Signatures/`.

## What animates where

Clients that keep embedded CSS (Apple Mail, iOS Mail, Outlook for Mac,
Thunderbird, Samsung Mail) play the motion. Gmail, Outlook.com and Outlook for
Windows strip it and show the same card still. Motion is gated behind
`prefers-reduced-motion`. These expectations come from published client
CSS-support data, not a device pass; send a test to each account before
rolling out.

## Palette (current, pending the logo)

Navy `#0A1628` / `#122240` · gold `#C9A84C` · light gold `#F1DEA0` · deep gold
`#8A6D1F` · ivory `#F5F1E6`. Georgia for the name and wordmark, Arial
elsewhere, so it renders identically without web fonts.
