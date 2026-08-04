/**
 * Batch 7 — generate the 8 real-image OCR verification fixtures.
 *
 * Renders realistic business-card SVGs (Noto Sans / Noto Sans Arabic — installed
 * in ~/.fonts) through sharp/librsvg, then applies the required degradations:
 *   1. english-clean.jpg      — clean, well-lit English card
 *   2. arabic-bilingual.jpg   — Arabic + English bilingual card
 *   3. rotated.jpg            — English card rotated 90°
 *   4. perspective.jpg        — English card with an affine skew (perspective-ish)
 *   5. low-light.jpg          — heavily darkened English card
 *   6. low-res.jpg            — downscaled to 260px wide, re-upscaled (blur/blockiness)
 *   7. cropped.jpg            — right third + bottom edge cut off (partial data)
 *   8. non-card.jpg           — a landscape gradient scene, no card, no contact text
 *
 * Run: npx tsx scripts/generate-ocr-fixtures.ts
 * Output: scripts/ocr-fixtures/*.jpg
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "ocr-fixtures");

// The ground truth printed on the English card. verify-ocr-live.ts compares
// extraction output against these values.
export const ENGLISH_CARD = {
  firstName: "Sarah",
  lastName: "Mitchell",
  jobTitle: "Regional Sales Director",
  company: "Meridian Gulf Trading LLC",
  email: "Sarah.Mitchell@MeridianGulf.ae",
  mobile: "+971 50 774 2196",
  website: "www.meridiangulf.ae",
  city: "Dubai",
  country: "United Arab Emirates",
};

export const ARABIC_CARD = {
  firstName: "Khalid",
  lastName: "Al Mansouri",
  arabicName: "خالد المنصوري",
  jobTitle: "General Manager",
  arabicJobTitle: "المدير العام",
  company: "Al Noor Industries",
  arabicCompany: "صناعات النور",
  email: "k.almansouri@alnoor-ind.com",
  mobile: "+971 52 883 4471",
  city: "Abu Dhabi",
  arabicCity: "أبوظبي",
};

function englishCardSvg(): string {
  const c = ENGLISH_CARD;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1050" height="600">
  <rect width="1050" height="600" fill="#fdfdfb"/>
  <rect x="0" y="0" width="1050" height="14" fill="#0e4d78"/>
  <rect x="0" y="586" width="1050" height="14" fill="#0e4d78"/>
  <text x="70" y="150" font-family="Noto Sans" font-weight="700" font-size="56" fill="#123">${c.firstName} ${c.lastName}</text>
  <text x="70" y="205" font-family="Noto Sans" font-size="30" fill="#0e4d78">${c.jobTitle}</text>
  <text x="70" y="255" font-family="Noto Sans" font-weight="700" font-size="34" fill="#333">${c.company}</text>
  <text x="70" y="360" font-family="Noto Sans" font-size="27" fill="#222">Mobile: ${c.mobile}</text>
  <text x="70" y="405" font-family="Noto Sans" font-size="27" fill="#222">Email: ${c.email}</text>
  <text x="70" y="450" font-family="Noto Sans" font-size="27" fill="#222">Web: ${c.website}</text>
  <text x="70" y="520" font-family="Noto Sans" font-size="25" fill="#555">${c.city}, ${c.country}</text>
</svg>`;
}

function arabicCardSvg(): string {
  const c = ARABIC_CARD;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1050" height="600">
  <rect width="1050" height="600" fill="#fffef8"/>
  <rect x="0" y="0" width="1050" height="90" fill="#14532d"/>
  <text x="60" y="60" font-family="Noto Sans" font-weight="700" font-size="34" fill="#fff">${c.company}</text>
  <text x="990" y="60" font-family="Noto Sans Arabic" font-weight="700" font-size="34" fill="#fff" text-anchor="end">${c.arabicCompany}</text>
  <text x="60" y="200" font-family="Noto Sans" font-weight="700" font-size="48" fill="#123">${c.firstName} ${c.lastName}</text>
  <text x="990" y="200" font-family="Noto Sans Arabic" font-weight="700" font-size="46" fill="#123" text-anchor="end">${c.arabicName}</text>
  <text x="60" y="260" font-family="Noto Sans" font-size="28" fill="#14532d">${c.jobTitle}</text>
  <text x="990" y="260" font-family="Noto Sans Arabic" font-size="28" fill="#14532d" text-anchor="end">${c.arabicJobTitle}</text>
  <text x="60" y="380" font-family="Noto Sans" font-size="26" fill="#222">Mobile: ${c.mobile}</text>
  <text x="60" y="425" font-family="Noto Sans" font-size="26" fill="#222">Email: ${c.email}</text>
  <text x="60" y="500" font-family="Noto Sans" font-size="24" fill="#555">${c.city}, UAE</text>
  <text x="990" y="500" font-family="Noto Sans Arabic" font-size="24" fill="#555" text-anchor="end">${c.arabicCity}</text>
</svg>`;
}

function nonCardSvg(): string {
  // A landscape scene: sky gradient, sun, hills. No card, no contact data.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1050" height="700">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#7ec8f7"/><stop offset="100%" stop-color="#e8f4fd"/>
    </linearGradient>
  </defs>
  <rect width="1050" height="700" fill="url(#sky)"/>
  <circle cx="850" cy="140" r="70" fill="#ffd75e"/>
  <path d="M0 520 Q 260 380 520 500 T 1050 470 V 700 H 0 Z" fill="#7aa15c"/>
  <path d="M0 600 Q 350 500 700 590 T 1050 580 V 700 H 0 Z" fill="#5c8a45"/>
</svg>`;
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const english = await sharp(Buffer.from(englishCardSvg())).jpeg({ quality: 88 }).toBuffer();
  const arabic = await sharp(Buffer.from(arabicCardSvg())).jpeg({ quality: 88 }).toBuffer();

  await fs.writeFile(path.join(OUT, "english-clean.jpg"), english);
  await fs.writeFile(path.join(OUT, "arabic-bilingual.jpg"), arabic);

  // 3. rotated 90° (portrait orientation, as if the phone was sideways)
  await fs.writeFile(path.join(OUT, "rotated.jpg"), await sharp(english).rotate(90).jpeg({ quality: 88 }).toBuffer());

  // 4. perspective-ish skew via affine transform
  await fs.writeFile(
    path.join(OUT, "perspective.jpg"),
    await sharp(english)
      .affine([[1, 0.18], [0.06, 0.94]], { background: "#666" })
      .jpeg({ quality: 88 })
      .toBuffer(),
  );

  // 5. low light: brightness way down + slight desaturation
  await fs.writeFile(
    path.join(OUT, "low-light.jpg"),
    await sharp(english).modulate({ brightness: 0.28, saturation: 0.8 }).jpeg({ quality: 80 }).toBuffer(),
  );

  // 6. low resolution: crush to 260px wide, back up to 780 (soft + blocky)
  const tiny = await sharp(english).resize({ width: 260 }).jpeg({ quality: 55 }).toBuffer();
  await fs.writeFile(
    path.join(OUT, "low-res.jpg"),
    await sharp(tiny).resize({ width: 780 }).jpeg({ quality: 70 }).toBuffer(),
  );

  // 7. cropped: cut off the right third and bottom edge (email/web partially gone)
  await fs.writeFile(
    path.join(OUT, "cropped.jpg"),
    await sharp(english).extract({ left: 0, top: 0, width: 700, height: 430 }).jpeg({ quality: 88 }).toBuffer(),
  );

  // 8. non-card image
  await fs.writeFile(
    path.join(OUT, "non-card.jpg"),
    await sharp(Buffer.from(nonCardSvg())).jpeg({ quality: 88 }).toBuffer(),
  );

  const files = await fs.readdir(OUT);
  for (const f of files.sort()) {
    const st = await fs.stat(path.join(OUT, f));
    console.log(`${f}  ${(st.size / 1024).toFixed(1)} KB`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
