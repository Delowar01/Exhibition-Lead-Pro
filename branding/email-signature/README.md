# Elite Marcom — animated HTML email signature

Signature for **Mohammad Delowar Hossain, Chief Operating Officer**.

| File | Purpose |
| --- | --- |
| `elite-marcom-signature.html` | The signature itself. Table-based, inline-styled, with an optional `<style>` block that adds motion. |
| `preview.html` | Open in a browser: live animated preview, copy buttons, install steps per mail client. |
| `assets/*.png` | Social and contact icons (64 px social discs, 32 px contact glyphs), transparent PNG. `*.svg` are the sources. |

## 1. Host the images

Email clients only load images from a URL, so upload these to
`https://www.elitemarcom.com/signature/` (or any public folder, then update
the URLs in the HTML):

| File | Spec | Status |
| --- | --- | --- |
| `photo.jpg` | 240 × 240 px square crop of the headshot | **you add** |
| `logo.png` | 360 × 120 px, transparent, white/gold version for the navy band | optional |
| `linkedin.png` `instagram.png` `facebook.png` `youtube.png` | 64 × 64 px | in `assets/` |
| `phone.png` `pin.png` `globe.png` | 32 × 32 px | in `assets/` |

To point at a different host, replace the base URL in one go:

```bash
sed -i 's#https://www.elitemarcom.com/signature/#https://YOUR-HOST/path/#g' elite-marcom-signature.html
```

The company wordmark in the navy band is live text, so the signature is
complete before `logo.png` exists. When the logo is uploaded, swap the
wordmark for the `<img>` shown in the `LOGO SLOT` comment inside the HTML.

## 2. Install

Open `preview.html` in a desktop browser and use its copy buttons.

- **Gmail**: *Copy rendered* → Settings → See all settings → General →
  Signature → Create new → paste → set as default → Save changes.
- **Outlook (web / new desktop)**: *Copy rendered* → Settings → Accounts →
  Signatures → New → paste → Save.
- **Apple Mail**: Mail → Settings → Signatures → add → untick *Always match my
  default message font* → paste. For the full animation, put the *Copy HTML*
  output into the signature's `.mailsignature` file under
  `~/Library/Mail/V10/MailData/Signatures/`.

## 3. What animates where

The `<style>` block carries a rotating gold photo ring, a shimmering gold
rule, a staggered row reveal and an icon hover lift, all gated behind
`prefers-reduced-motion`. Clients that keep embedded CSS (Apple Mail, iOS
Mail, Outlook for Mac, Thunderbird, Samsung Mail) play it. Gmail, Outlook.com
and Outlook for Windows strip embedded CSS and show the same card still; no
content, link or colour depends on the animation.

These expectations come from published client CSS-support data, not from a
device pass on this signature. Send a test to each of your own accounts
before rolling it out.

## Palette and type

Navy `#0B1F3A` · gold `#C9A227` · pale gold `#F3E4A6` · slate `#3C4757`.
Georgia for the name and wordmark, Arial for everything else, so the
signature renders identically without web fonts.
