#!/usr/bin/env node
/**
 * Elite Marcom email signature builder.
 *   node build.js            → writes elite-marcom-signature.html (hosted URLs),
 *                              elite-marcom-signature-embedded.html (images inlined as base64),
 *                              preview.html, and regenerates the icon PNGs in ./assets
 *
 * Change BRAND below to match the logo, drop photo.jpg / logo.png into ./assets, rebuild.
 */
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');

const BRAND = {
  navy:      '#0A1628',   // card ground
  navy2:     '#122240',   // gradient end / hover
  gold:      '#C9A84C',   // primary gold
  goldLight: '#F1DEA0',   // highlight
  goldDeep:  '#8A6D1F',   // shadow gold
  ivory:     '#F5F1E6',   // headline text on navy
  text:      '#D5DBE6',   // body text on navy
  muted:     '#8E9BB3',   // secondary text
};
const PERSON = {
  name: 'Mohammad Delowar Hossain',
  title: 'Chief Operating Officer',
  company: 'Elite Marcom',
  address: '8809 Al Aziziyah Dist., Riyadh 14514, Saudi Arabia',
  mobile: '+966 53 381 0775', mobileHref: 'tel:+966533810775',
  site: 'www.elitemarcom.com', siteHref: 'https://www.elitemarcom.com',
  socials: [
    ['linkedin',  'LinkedIn',  'https://www.linkedin.com/company/elite-marcom'],
    ['instagram', 'Instagram', 'https://www.instagram.com/elitemarcom'],
    ['facebook',  'Facebook',  'https://www.facebook.com/profile.php?id=61558899995583'],
    ['youtube',   'YouTube',   'https://www.youtube.com/@Elite_Marcom'],
  ],
};
const ASSET_BASE = 'https://www.elitemarcom.com/signature/';
const CHROME = process.env.CHROME || '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell';

const DIR = __dirname, ASSETS = path.join(DIR, 'assets');
fs.mkdirSync(ASSETS, { recursive: true });

/* ---------- icons ---------- */
const GLYPH = JSON.parse(fs.readFileSync(path.join(DIR, 'glyphs.json'), 'utf8'));
const SOCIAL = PERSON.socials.map(s => s[0]);
function iconSvg(name) {
  const d = GLYPH[name];
  if (SOCIAL.includes(name)) // gold hairline disc, gold glyph, transparent centre (sits on navy)
    return `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72"><circle cx="36" cy="36" r="34" fill="${BRAND.navy2}" stroke="${BRAND.gold}" stroke-width="2"/><g transform="translate(18 18) scale(1.5)"><path fill="${BRAND.goldLight}" d="${d}"/></g></svg>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24"><path fill="${BRAND.gold}" d="${d}"/></svg>`;
}
function renderIcons() {
  if (!fs.existsSync(CHROME)) { console.warn('Chromium not found; keeping existing PNGs'); return; }
  for (const name of Object.keys(GLYPH)) {
    const svg = iconSvg(name), size = SOCIAL.includes(name) ? 72 : 32;
    fs.writeFileSync(path.join(ASSETS, name + '.svg'), svg);
    const tmp = path.join(ASSETS, `.${name}.html`);
    fs.writeFileSync(tmp, `<html><body style="margin:0;background:transparent">${svg}</body></html>`);
    execFileSync(CHROME, ['--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--default-background-color=00000000',
      `--window-size=${size},${size}`, `--screenshot=${path.join(ASSETS, name + '.png')}`, 'file://' + tmp], { stdio: 'ignore' });
    fs.unlinkSync(tmp);
  }
}

/* ---------- image sources ---------- */
const dataUri = (file, mime) => `data:${mime};base64,` + fs.readFileSync(file).toString('base64');
const photoFile = ['photo.jpg', 'photo.jpeg', 'photo.png'].map(f => path.join(ASSETS, f)).find(fs.existsSync);
const logoFile = ['logo.png', 'logo.jpg'].map(f => path.join(ASSETS, f)).find(fs.existsSync);
const placeholderPhoto = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240"><rect width="240" height="240" fill="${BRAND.navy2}"/><circle cx="120" cy="92" r="40" fill="#25395E"/><path d="M40 220c8-52 44-78 80-78s72 26 80 78z" fill="#25395E"/><text x="120" y="228" text-anchor="middle" font-family="Arial" font-size="12" fill="${BRAND.muted}" letter-spacing="3">PHOTO.JPG</text></svg>`);

function sources(mode) {
  const s = {};
  for (const n of Object.keys(GLYPH))
    s[n] = mode === 'hosted' ? ASSET_BASE + n + '.png' : dataUri(path.join(ASSETS, n + '.png'), 'image/png');
  s.photo = mode === 'hosted' ? ASSET_BASE + 'photo.jpg'
          : photoFile ? dataUri(photoFile, photoFile.endsWith('.png') ? 'image/png' : 'image/jpeg') : placeholderPhoto;
  s.logo = mode === 'hosted' ? ASSET_BASE + 'logo.png' : logoFile ? dataUri(logoFile, logoFile.endsWith('.png') ? 'image/png' : 'image/jpeg') : null;
  s.hasLogo = mode === 'hosted' ? !!logoFile : !!logoFile;
  return s;
}

/* ---------- markup ---------- */
const B = BRAND, P = PERSON;
const STYLE = `<style type="text/css">
  @keyframes emsRise   { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes emsSpin   { to { transform: rotate(360deg); } }
  @keyframes emsUnspin { to { transform: rotate(-360deg); } }
  @keyframes emsGrow   { from { width: 0; } to { width: 64px; } }
  @keyframes emsShine  { from { background-position: 200% 0; } to { background-position: -200% 0; } }
  @keyframes emsGlow   { 0%,100% { box-shadow: 0 0 0 0 rgba(201,168,76,0); } 50% { box-shadow: 0 0 22px 2px rgba(201,168,76,.45); } }
  .ems-r1,.ems-r2,.ems-r3,.ems-r4,.ems-r5,.ems-r6,.ems-r7 { animation: emsRise .8s cubic-bezier(.22,.61,.36,1) both; }
  .ems-r2{animation-delay:.10s}.ems-r3{animation-delay:.20s}.ems-r4{animation-delay:.32s}.ems-r5{animation-delay:.42s}.ems-r6{animation-delay:.52s}.ems-r7{animation-delay:.64s}
  .ems-ring { animation: emsSpin 10s linear infinite, emsGlow 4s ease-in-out infinite; }
  .ems-ring img { animation: emsUnspin 10s linear infinite; }
  .ems-rule { animation: emsGrow 1s cubic-bezier(.22,.61,.36,1) .55s both; }
  .ems-bar { background-image: linear-gradient(90deg, ${B.goldDeep} 0%, ${B.gold} 30%, ${B.goldLight} 50%, ${B.gold} 70%, ${B.goldDeep} 100%) !important; background-size: 200% 100% !important; animation: emsShine 3.6s linear infinite; }
  .ems-soc img { transition: transform .25s ease, filter .25s ease; }
  .ems-soc:hover img { transform: translateY(-3px) scale(1.08); filter: drop-shadow(0 6px 10px rgba(201,168,76,.45)); }
  .ems-link { transition: color .2s ease; } .ems-link:hover { color: ${B.goldLight} !important; }
  @media (prefers-reduced-motion: reduce) { .ems-r1,.ems-r2,.ems-r3,.ems-r4,.ems-r5,.ems-r6,.ems-r7,.ems-ring,.ems-ring img,.ems-rule,.ems-bar { animation: none !important; } }
</style>`;

const row = (cls, icon, inner, pad) =>
  `<tr><td class="${cls}" style="font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;color:${B.text};padding-bottom:${pad}px;">
    <img src="${icon}" width="14" height="14" alt="" style="display:inline-block;vertical-align:-2px;width:14px;height:14px;margin-right:10px;border:0;">${inner}</td></tr>`;

function signature(src) {
  const brand = src.hasLogo
    ? `<img src="${src.logo}" width="140" alt="${P.company}" style="display:block;width:140px;height:auto;border:0;">`
    : `<a href="${P.siteHref}" style="color:${B.ivory};text-decoration:none;"><span style="color:${B.gold};">ELITE</span>&nbsp;MARCOM</a>`;
  const socials = P.socials.map(([k, label, href]) =>
    `<a class="ems-soc" href="${href}" title="${P.company} on ${label}" style="display:inline-block;text-decoration:none;margin-left:10px;"><img src="${src[k]}" width="34" height="34" alt="${label}" style="display:block;width:34px;height:34px;border:0;"></a>`).join('\n            ');
  return `${STYLE}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="620" style="width:620px;max-width:620px;border-collapse:separate;font-family:Arial,Helvetica,sans-serif;background:${B.navy};background-image:linear-gradient(135deg,${B.navy} 0%,${B.navy2} 100%);border:1px solid ${B.goldDeep};">
  <tr>
    <td style="padding:0;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
        <tr>
          <td width="166" valign="middle" style="padding:28px 8px 28px 30px;width:166px;">
            <div class="ems-r1" style="width:128px;height:128px;">
              <div class="ems-ring" style="width:128px;height:128px;border-radius:64px;background:${B.gold};background-image:conic-gradient(from 0deg,${B.gold},${B.goldLight},${B.gold},${B.goldDeep},${B.gold},${B.goldLight},${B.gold});line-height:0;">
                <img src="${src.photo}" width="116" height="116" alt="${P.name}" style="display:block;width:116px;height:116px;border-radius:58px;margin:6px;border:3px solid ${B.navy};object-fit:cover;">
              </div>
            </div>
          </td>
          <td width="1" style="width:1px;padding:0;"><div style="width:1px;height:132px;background:${B.goldDeep};background-image:linear-gradient(180deg,rgba(138,109,31,0) 0%,${B.gold} 50%,rgba(138,109,31,0) 100%);font-size:0;line-height:0;">&nbsp;</div></td>
          <td valign="middle" style="padding:26px 30px 24px 26px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
              <tr><td class="ems-r2" style="font-family:Georgia,'Times New Roman',serif;font-size:25px;line-height:30px;color:${B.ivory};font-weight:normal;letter-spacing:.3px;padding-bottom:4px;">${P.name}</td></tr>
              <tr><td class="ems-r3" style="font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:16px;color:${B.gold};font-weight:bold;letter-spacing:3px;text-transform:uppercase;">${P.title}</td></tr>
              <tr><td class="ems-r4" style="font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:16px;color:${B.muted};letter-spacing:.5px;padding-top:3px;">${P.company} &middot; Riyadh</td></tr>
              <tr><td style="padding:12px 0 13px 0;"><div class="ems-rule" style="width:64px;height:1px;background:${B.gold};font-size:0;line-height:0;">&nbsp;</div></td></tr>
              ${row('ems-r5', src.phone, `<a class="ems-link" href="${P.mobileHref}" style="color:${B.ivory};text-decoration:none;font-weight:bold;letter-spacing:.3px;">${P.mobile}</a>`, 6)}
              ${row('ems-r6', src.pin, P.address, 6)}
              ${row('ems-r7', src.globe, `<a class="ems-link" href="${P.siteHref}" style="color:${B.ivory};text-decoration:none;font-weight:bold;letter-spacing:.3px;">${P.site}</a>`, 0)}
            </table>
          </td>
        </tr>
      </table>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
        <tr><td class="ems-bar" height="2" style="height:2px;font-size:0;line-height:0;background:${B.gold};background-image:linear-gradient(90deg,${B.goldDeep} 0%,${B.gold} 35%,${B.goldLight} 50%,${B.gold} 65%,${B.goldDeep} 100%);">&nbsp;</td></tr>
      </table>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;background:#07101F;">
        <tr>
          <td valign="middle" style="padding:14px 30px;font-family:Georgia,'Times New Roman',serif;font-size:16px;line-height:22px;letter-spacing:4px;color:${B.ivory};white-space:nowrap;">${brand}</td>
          <td valign="middle" align="right" style="padding:11px 30px;white-space:nowrap;">
            ${socials}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`;
}

const HEADER = `<!--
  ELITE MARCOM — Animated HTML Email Signature · ${P.name}, ${P.title}
  Generated by build.js. Edit BRAND / PERSON there and rebuild rather than editing this file.
  · Table-based, inline-styled: renders in every mail client. The <style> block adds motion in clients that keep
    embedded CSS (Apple Mail, iOS Mail, Outlook for Mac, Thunderbird, Samsung Mail); others show the same still card.
  · %MODE%
-->
`;

renderIcons();
const hosted = sources('hosted'), embedded = sources('embedded');
fs.writeFileSync(path.join(DIR, 'elite-marcom-signature.html'),
  HEADER.replace('%MODE%', `Images load from ${ASSET_BASE} — upload ./assets/*.png plus photo.jpg (and logo.png) there, or change ASSET_BASE in build.js.`) + signature(hosted));
fs.writeFileSync(path.join(DIR, 'elite-marcom-signature-embedded.html'),
  HEADER.replace('%MODE%', 'Images are embedded as base64: opens correctly anywhere and installs in Outlook desktop / Apple Mail. Gmail strips embedded images — use the hosted version there.') + signature(embedded));

const tpl = fs.readFileSync(path.join(DIR, 'preview-template.html'), 'utf8');
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
fs.writeFileSync(path.join(DIR, 'preview.html'),
  tpl.replace('<!--SIGNATURE_PREVIEW-->', signature(embedded)).replace('<!--SIGNATURE_SOURCE-->', esc(signature(hosted)))
     .replace(/%PHOTO_STATUS%/g, photoFile ? 'Embedded' : 'You add').replace(/%LOGO_STATUS%/g, logoFile ? 'Embedded' : 'You add'));
console.log('built: signature (hosted), signature (embedded), preview.html, icons ×', Object.keys(GLYPH).length,
  '| photo:', photoFile ? path.basename(photoFile) : 'placeholder', '| logo:', logoFile ? path.basename(logoFile) : 'wordmark');
