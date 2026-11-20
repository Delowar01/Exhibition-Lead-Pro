# Launch pricing correctness and dashboard polish

Branch `claude/launch-pricing-ui-corrections`, stacked on the G-7 Platform Owner Analytics
branch (`claude/platform-owner-analytics-g7`). Web and one repository query only: **no
schema change, no migration, no index, no API-contract change, no provider activation.**
Verified locally with the fake billing provider; no real price, checkout session, invoice
or payment was created and nothing hosted was contacted.

This document closes three items that `docs/G7_PLATFORM_ANALYTICS.md` §9 lists as "left
unchanged" (the plan price screens, the notation of money, the dashboard's visual defects)
and replaces that section's description of `minorUnitDigits()`.

## 1. The problem

Prices are stored in the currency's **minor unit** (`plan_prices.unit_amount_minor`, and
`unitAmountMinor` of a plan version's manual prices). Three screens read and wrote them as
"amount ÷ 100" / "amount × 100" whatever the currency:

| Screen | Before |
| --- | --- |
| Platform → Plans (`pages/platform/Plans.tsx`), price list | `minor / 100` in the browser's notation |
| Company → Subscription (`pages/admin/Subscription.tsx`), prices offered for checkout | `minor / 100` in the browser's notation |
| Plan version editor (`components/platform/PlanVersions.tsx`), provider mappings and manual prices | display `minor / 100`; the form opened a price as `(minor / 100).toFixed(2)` and saved `Math.round(Number(text) * 100)` |

Consequences: a 5,000-yen price read "¥50" and opened in the form as "50.00"; typing 5000
for a yen price stored 500,000; 10.500 Kuwaiti dinars read "KWD 105.000"; and the form
went through binary floating point. An amount typed with more decimals than the currency
has was silently rounded.

The API was audited and is not affected: it stores and returns minor units and never
converts them (`lib/billing/plan-versions.ts`, `services/platform-billing.service.ts`,
`lib/billing/*`). The mobile app shows no subscription prices. CRM lead values are decimal
amounts in major units with their own conversion and formatting — a different domain, left
unchanged. Every other `/ 100` or `* 100` in the web and mobile apps is a percentage or a
score.

Two more monetary fields of the same editor were corrected with it:

- **AI cost allowance** (US dollars, stored in millionths of a dollar). It was a number
  field: anything the browser could not read came back empty and was saved as "no
  allowance". It is now a text field converted with the same exact arithmetic; a figure
  that cannot be converted is marked and the draft is not sent. Read-only views show it
  exactly, in the notation of prices ("$12.50").
- **Version comparison and publication summary.** The API reports a version's manual
  prices as one line of raw minor units ("usd/monthx1=4900"). The page now shows them as
  amounts ("$49.00 / month"); a line it cannot read exactly is shown as it came.

## 2. The rules, and where they come from

Source: Stripe, **"Supported currencies"**, <https://docs.stripe.com/currencies>, read on
2026-11-19 (sections *Supported presentment currencies*, *Zero-decimal currencies*,
*Special cases*, *Minimum and maximum charge amounts*).

| Rule | Stripe's wording | Applies to |
| --- | --- | --- |
| Amounts are integers in the minor unit | "All API requests expect `amount` values in the currency's minor unit" — "`1000` to charge 10 USD (or any other two-decimal currency)", "`10` to charge 10 JPY (or any other zero-decimal currency)" | charges, prices |
| Two decimals unless stated | "Currencies are two-decimal currencies unless otherwise specified." | charges, prices |
| Zero-decimal currencies | "the charge and the amount are the same, without requiring multiplication": BIF, CLP, DJF, GNF, JPY, KMF, KRW, MGA, PYG, RWF, UGX, VND, VUV, XAF, XOF, XPF | charges, prices |
| ISK and UGX | "transitioned to a zero-decimal currency, but backward compatibility requires you to represent it as a two-decimal value, where the decimal amount is always `00`. For example, to charge 5 ISK, provide an `amount` value of `500`. You can't charge fractions" (for UGX also: fractional invoice amounts are rounded "to the nearest number evenly divisible by 100") | charges, prices |
| HUF and TWD | "Stripe treats HUF as a zero-decimal currency for payouts, even though you can charge two-decimal amounts"; manual payouts must be "evenly divisible by 100" | **payouts only** |
| Supported currencies | the presentment list: 134 codes for a United States account; a United Arab Emirates account adds BHD, JOD, KWD, OMR and TND (139 in all) | charges |
| Limits | a minimum per settlement currency; at most 8 digits for most non-card methods, up to 12 for cards | charges |

Charge, payout and display are three different things:

- **Charge / price rule** — how many minor units make one unit. This is what this product
  stores, so it is the only rule the conversion uses.
- **Payout rule** — HUF and TWD payouts are whole units. The product makes no payouts, so
  forints and New Taiwan dollars are ordinary two-decimal currencies here (4,900 forints
  are stored as 490000 and read "HUF 4,900.00").
- **Display rule** — how an amount is written for people. Icelandic krónur and Ugandan
  shillings are stored in hundredths but have no fraction, so they are written without
  decimals ("ISK 500" for 50000).

Two points where the page does not settle the matter. Both are decisions recorded here,
and **both are to be confirmed with the provider before such a currency is used for a
live provider price**:

1. **UGX is both in the zero-decimal list and in the special cases.** The special case is
   the more specific statement and agrees with ISK; UGX is treated as stored in
   hundredths, whole units only. (Under the other reading every UGX amount would be 100
   times smaller.)
2. **The page states no three-decimal rule in its body** (only its summary mentions
   "three-decimal currency support"). BHD, JOD, KWD, OMR and TND are given three decimals,
   as in ISO 4217, and the editor accepts any third decimal. Whether the provider
   restricts the third decimal of a *charge* in these currencies (for example to 0) is not
   stated on the page as read. It would concern provider prices, which the provider
   validates itself; the amounts typed in the editor are manual prices, which the product
   never charges.

The supported list is the union of those two account countries as the page prints them;
the lists for other account countries were not all compared.

## 3. The policy (`artifacts/web-app/src/lib/money.ts`)

One module holds every rule; nothing else in the web app converts or formats a minor
amount.

| Kind | Currencies | Stored = typed × | Decimals typed / shown | Example |
| --- | --- | --- | --- | --- |
| two-decimal | every supported currency not listed below (USD, SAR, EUR, AED, HUF, TWD …) | 100 | 2 | "1250.5" SAR → 125050 → "SAR 1,250.50" |
| zero-decimal | BIF CLP DJF GNF JPY KMF KRW MGA PYG RWF VND VUV XAF XOF XPF | 1 | 0 | "5000" JPY → 5000 → "¥5,000" |
| whole units in hundredths | ISK UGX | 100 | 0 | "500" ISK → 50000 → "ISK 500" |
| three-decimal | BHD JOD KWD OMR TND | 1000 | 3 | "10.5" KWD → 10500 → "KWD 10.500" |
| unsupported / unknown | anything else | — | — | 5000 "xyz" → "5,000 XYZ (minor units)" |

- **No floating point.** Typed text is parsed as a string of digits and scaled by moving
  the decimal point (`decimalToScaled`); reading back does the reverse
  (`scaledToDecimal`). Every cent from 0.00 to 99.99, and 3,000 pseudo-random amounts per
  kind, convert there and back without change.
- **Nothing is rounded or guessed on entry.** More decimals than the currency has ("49.999"
  USD, "5000.5" JPY, "500.50" ISK), signs, exponents and blanks are refused with a message
  that names the rule. A comma or a space is refused too — "1,250" could be 1250 or 1.250
  — with a message that says how to write the amount.
- **Unknown currencies are never assumed to have two decimals.** A code outside the
  supported list has no rule: it is shown as its stored minor units with the code, and it
  cannot be given a new amount.
- **Limits.** The editor enforces the API's maximum (1,000,000,000 minor units) on what is
  typed and shows it in the currency's own unit.
- **One notation.** Money is written in US-English notation everywhere (it used to follow
  the browser on two of the screens, so one price could be written two ways).
- `formatMinor()` writes the fraction from the exact digits, not from a division.
  `formatMicroUsd()` does the same for the AI cost figures.

### The manual-price form (`artifacts/web-app/src/lib/manual-prices.ts`)

- Opening a stored price shows its exact amount in the currency's unit ("49.00", "5000",
  "10.500").
- **A price that was not edited is sent back as the very integer that was stored.** This
  keeps every existing price — including one in an unsupported currency, or a fractional
  króna that could no longer be typed.
- Typing the shown amount again gives the same stored integer (the text alone carries the
  value), for every supported currency.
- Changing the amount or the currency re-reads the text under the (new) currency's rule.
- An invalid row is marked in place, the draft is not sent, and a message says why.
- The amount is a text field with the ordinary keyboard: a "decimal" keypad offers only a
  comma in some locales.

## 4. Existing data

Nothing stored is changed, and nothing in this batch reads or writes the hosted database.

Provider prices are stored exactly as the provider reports them, so they were always
correct in the database and are now also read correctly.

**One thing to check before launch (read-only):** a *manual* price that was typed into the
old form in a currency that is not two-decimal was stored as "typed × 100". Under the
correct reading it now shows 100 times too large for a zero-decimal currency (old "5000"
yen → stored 500000 → "¥500,000") and 10 times too small for a three-decimal one. Manual
prices are display-only (the product never bills them), and USD / SAR / EUR / AED prices
are unaffected. List the manual prices of every plan version whose currency is one of the
zero-decimal, whole-unit or three-decimal codes above and re-enter any that were typed
through the old form.

## 5. What the API still accepts

No API or database contract was changed. The API validates a manual price as a
three-letter currency code and an integer from 0 to 1,000,000,000; it does not know the
currency list. A caller of the API (not the editor) can therefore still store a manual
price in a code the billing provider does not support. The editor shows such a price as
stored minor units and keeps it unchanged. Refusing it on the server needs the currency
policy on the API side (a shared module and a new validation error) — **a contract change,
not made here; it needs its own approval.** The same holds for the comparison's one-line
summary of manual prices: the server still sends raw minor units and the page reads them.

`monthlyRecurringMinorOf()` (the MRR estimate) still divides yearly and weekly prices with
ordinary arithmetic and rounds the total once. It is an estimate by definition and is left
as it is.

## 6. Platform Dashboard refinements (`/platform`)

| Defect | Cause | Now |
| --- | --- | --- |
| "Total Companies" cut off at desktop width | six cards in one row left about 100 px for a label | the cards sit one, two or (from 1280 px) three to a row; every label fits and carries its full text as a tooltip |
| A long ARR amount ran past its card | same row, and a figure of fixed size | the MRR and ARR figures are sized to their card: full size wherever they fit, smaller only as far as needed to stay on one line. Measured: amounts of up to 21 characters ("SAR 11,851,851,852.12") stay on one line from 320 to 1440 px; a longer one wraps inside the card at the narrowest layout instead of leaving it. Other cards are not affected |
| Low-contrast label and icon on the dark card | muted grey on the dark surface (about 3 : 1) | a `tone="inverse"` on the shared metric card: label, icon and footer use the sidebar's foreground colour (≥ 4.5 : 1 for text in both themes) |
| Subscription Status legend overlapped the list | the chart drew its own legend over the rows beneath it | the list is the legend: each row has the colour dot of its ring segment, the status and the count; the chart draws no second legend |
| Status ring clipped and status names cut between 768 and 1279 px | the status card was two sevenths of the row at every width from 768 px, narrower than its 160 px ring | the status card sits beside the revenue chart from 1280 px and beneath it, at full width, below that; the ring and every name are whole at every width |
| "Past due" and "Suspended" had the same colour | two tokens with the same value | "Past due" takes the fifth colour of the chart palette, which no other status used. (Trialing's navy and Expired's grey remain the closest pair of the palette; unchanged) |
| Recent Companies listed the five oldest | `GET /companies` ordered by creation time ascending | newest first, the id breaking ties (stable paging); the card says "The five tenants onboarded most recently" |
| Sideways scroll of the plan page at tablet width when provider prices exist | a grid column could not shrink below its table | the columns may shrink; the table scrolls inside its card |

The order of `GET /companies` is not part of the contract (the specification states none)
and the endpoint is the platform owner's; no consumer depended on the old order. It is
nevertheless an observable change: **the Platform → Companies page now also leads with the
newest tenants.** Metric definitions are unchanged (G-7).

Left as it is, noted: the "View all" link uses the design system's link colour (the brand
orange on white, about 2.9 : 1 in the light theme). It is the same style as every other
text link of the portal; changing it is a design-system decision, not a dashboard fix.

## 7. Tests

| Suite | What it proves |
| --- | --- |
| `src/lib/money.test.ts` (web unit) | the supported list code for code against the page's lists; the rule of every currency; exact parsing and reading; refusals and their messages; limits; round trips for all 139 codes; formatting, including unknown currencies and the AI cost figures |
| `src/lib/manual-prices.test.ts` (web unit) | opening; saving untouched and typing the shown amount again (every currency); stored currencies in any case; editing; currency change; limits; create → save → open → save; the comparison's summary line read back as prices |
| `test/lp-pricing-and-company-order.test.ts` (API) | manual prices in USD / SAR / JPY / ISK / HUF / KWD come back as written, through repeated saves and publication; amount and currency boundaries; provider prices stored as reported; platform-owner-only access; company list newest first with stable paging, filters and the five-newest request |
| `e2e/zi-pricing-currencies.spec.ts` (Playwright) | typing each currency in the editor stores the exact minor amount and reopens as typed; thirteen inputs are refused in the editor and a save with a refused row sends nothing; the AI cost allowance; an unsupported stored currency is kept; published prices, the comparison, the Subscriptions and Plans pages, version mappings and the tenant's checkout card read each price in its own unit; permissions; the editor and the published view at 820 / 390 / 1440-dark |
| `e2e/zh-platform-dashboard.spec.ts` (Playwright) | the six cards at 1440 / 820 / 390 / 320, no label cut, cards of a row equally tall; ordinary amounts at full size and six-figure amounts on one line at seven widths; a fifteen-digit amount inside its card; the legend against the API's counts; six statuses in six colours (both themes); the ring and legend whole at eight widths; Recent Companies newest first (the database as oracle); contrast of every label, figure and icon in the light and dark themes |

Totals of the full regression are in the pull request.

## 8. Not in this batch

- No index, no `0041`, no schema fingerprint change: the five-index G-7 proposal stays a
  proposal for a later, separately authorised step.
- No server-side currency validation (§5).
- No change to the living documents; when this branch is integrated, add this document to
  the docs of record and update the test totals in `docs/LOCALHOST_DEVELOPMENT.md` §7.
