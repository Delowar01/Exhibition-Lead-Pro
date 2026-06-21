---
name: NFC/QR shared parser + NFC multi-tech fix
description: parseQr is the shared parser for all text payloads; NFC tech-request must be multi-tech array, not single Ndef string.
---

## Shared parser
`parseQr` in `mobile/lib/contact-parse.ts` is the single source of truth for
all free-text contact payloads coming from QR codes and NFC NDEF text/URI
records. Extend it there; don't fork per-surface.

## NFC multi-tech request (critical)
`requestTechnology(NfcTech.Ndef)` with a single tech causes a silent hang when
the physical tag's NDEF layer isn't recognised by `Ndef.get(tag)`. The
`TagTechnologyRequest.connect()` Java method returns `false` and the native
Callback is never invoked — the JS promise never resolves.

**Always pass a priority array:**
```js
await NfcManager.requestTechnology(
  [NfcTech.Ndef, NfcTech.NfcA, NfcTech.IsoDep, NfcTech.MifareUltralight,
   NfcTech.MifareClassic, NfcTech.NdefFormatable, NfcTech.NfcB, NfcTech.NfcV],
  { alertMessage: "..." }
);
```

The JS wrapper (`NfcManagerAndroid.requestTechnology`) already handles arrays:
`if (typeof tech === 'string') { tech = [tech]; }` — array stays as-is.

**Why:** Android's TagTechnologyRequest iterates the list and connects to the
first matching technology. With only `Ndef`, a non-NDEF tag silently times out.

## AndroidManifest
The Expo plugin (`app.plugin.js`) adds the NFC **permission** but NOT the
**feature** declaration. `<uses-feature android:name="android.hardware.nfc"
android:required="false"/>` must be in the hand-edited AndroidManifest.xml.

## NDEF data after multi-tech connect
`getTag()` in Java checks `tag.getTechList().contains(Ndef.class.getName())`.
If the tag was connected via NfcA but is NDEF-formatted, the NDEF message IS
still populated in `tag.ndefMessage`. If the tag has no NDEF layer at all,
`ndefMessage` will be absent — check `tag.techTypes` to report what chip was found.

## Logging
All NFC log lines are tagged `[NFC]` — filter in Logcat/Metro with:
  `adb logcat | grep NFC`
