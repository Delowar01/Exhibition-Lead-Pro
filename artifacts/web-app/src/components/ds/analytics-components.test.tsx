import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { describe, it, expect } from "vitest";
import { BreakdownList, SegmentedBar } from "./Breakdown";
import { ChartCard, DataTable } from "./ChartCard";
import { ChartLegend, TrendChart } from "./TrendChart";
import { MetricCard } from "./MetricCard";

// G-7 — component tests for the analytics building blocks added to the design system.
// Components are rendered to static markup (react-dom/server), so these run without a
// browser. Interaction (view switch, tooltips, keyboard) is covered by the Playwright suite.

const html = (el: ReactElement) => renderToStaticMarkup(<Router ssrPath="/platform/analytics">{el}</Router>);
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const widths = (markup: string) => [...markup.matchAll(/width:([\d.]+)%/g)].map((m) => Number(m[1]));

describe("MetricCard — what a change means", () => {
  it("colours a rise as good by default and a fall as bad", () => {
    expect(html(<MetricCard label="Scans" value="10" delta={12.5} />)).toContain("text-success");
    expect(html(<MetricCard label="Scans" value="10" delta={-4} />)).toContain("text-destructive");
  });

  it("inverts the meaning for a metric where lower is better", () => {
    const up = html(<MetricCard label="Failed sign-ins" value="9" delta={50} deltaIntent="lower-better" />);
    expect(up).toContain("text-destructive");
    expect(up).not.toContain("text-success");
    expect(html(<MetricCard label="Failed sign-ins" value="9" delta={-50} deltaIntent="lower-better" />)).toContain("text-success");
  });

  it("never colours a neutral metric, and prints the signed percentage either way", () => {
    const m = html(<MetricCard label="AI requests" value="4" delta={353.4} deltaIntent="neutral" />);
    expect(m).not.toContain("text-success");
    expect(m).not.toContain("text-destructive");
    expect(text(m)).toContain("+353.4%");
    expect(text(html(<MetricCard label="x" value="1" delta={-25} />))).toContain("-25%");
  });

  it("shows no change indicator when there is no comparison", () => {
    const m = html(<MetricCard label="Subscriptions" value="41" footer="One per company" />);
    expect(m).not.toContain("%");
    expect(text(m)).toBe("Subscriptions 41 One per company");
  });
});

describe("MetricCard — a figure fitted to its card", () => {
  it("is opt-in: without `fit` the figure is rendered as it always was", () => {
    const plain = html(<MetricCard label="MRR" value="SAR 123,456.78" />);
    expect(plain).not.toContain("@container");
    expect(plain).not.toContain("cqi");
    expect(plain).not.toContain("overflow-wrap");
    expect(plain).toContain(">SAR 123,456.78</p>");
  });

  it("with `fit`, sizes a text figure by the card's width and the number of its characters", () => {
    const fitted = html(<MetricCard label="MRR" value="SAR 123,456.78" fit />);
    expect(fitted).toContain("@container");
    // 14 characters: the card's width ÷ 14 ÷ 0.6 em, between 1rem and the ordinary figure size.
    expect(fitted).toContain("font-size:clamp(1rem, calc(100cqi / 14 / 0.6), 1.875rem)");
    expect(text(fitted)).toBe("MRR SAR 123,456.78");
    expect(html(<MetricCard label="MRR" value="$1,766.00" fit />)).toContain("calc(100cqi / 9 / 0.6)");
    // A longer figure asks for a smaller share of the width per character, never a larger one.
    expect(html(<MetricCard label="ARR" value="SAR 118,518,518,521.44" fit />)).toContain("calc(100cqi / 22 / 0.6)");
  });

  it("leaves anything that is not text alone, even with `fit`", () => {
    const node = html(<MetricCard label="MRR" value={<span className="text-xl">Unavailable</span>} fit />);
    expect(node).not.toContain("@container");
    expect(node).not.toContain("cqi");
    expect(text(node)).toBe("MRR Unavailable");
    expect(html(<MetricCard label="x" value="" fit />)).toContain("calc(100cqi / 1 / 0.6)");
  });
});

describe("BreakdownList", () => {
  const items = [
    { key: "a", label: "AI vision", value: 300 },
    { key: "b", label: "QR", value: 100 },
    { key: "c", label: "NFC", value: 0 },
  ];

  it("prints every row's own figure and share, so no value depends on the bar or its colour", () => {
    const m = html(<BreakdownList items={items} label="Scans by method" />);
    expect(text(m)).toBe("AI vision 300 75% QR 100 25% NFC 0 0%");
    expect(m).toContain('aria-label="Scans by method"');
  });

  it("scales bars to the largest row and draws nothing for zero", () => {
    expect(widths(html(<BreakdownList items={items} label="x" />))).toEqual([100, expect.closeTo(33.33, 1), 0]);
  });

  it("keeps a tiny non-zero row visible and labels a share below one per cent honestly", () => {
    const m = html(<BreakdownList items={[{ key: "a", label: "Big", value: 1000 }, { key: "b", label: "Tiny", value: 1 }]} label="x" />);
    expect(widths(m)[1]).toBeGreaterThan(0);
    expect(text(m)).toContain("Tiny 1 &lt;1%");
  });

  it("shows the empty message when there is nothing to break down", () => {
    expect(text(html(<BreakdownList items={[]} label="x" empty="No scans in this period." />))).toBe("No scans in this period.");
    const zeros = html(<BreakdownList items={[{ key: "a", label: "A", value: 0 }]} label="x" empty="Nothing yet." testId="list" />);
    expect(text(zeros)).toBe("Nothing yet.");
    expect(zeros).toContain('data-testid="list-empty"');
    expect(zeros).not.toContain("<ul");
  });

  it("can hide shares, format values, show hints, and link a row to its page", () => {
    const m = html(
      <BreakdownList
        items={[{ key: "p", label: "Business", value: 104300, hint: "7 priced subscriptions", href: "/platform/plans" }]}
        valueFormat={(n) => `$${(n / 100).toFixed(2)}`}
        showShare={false}
        label="x"
      />,
    );
    expect(text(m)).toBe("Business $1043.00 7 priced subscriptions");
    expect(m).toContain('href="/platform/plans"');
    expect(m).not.toContain("100%</span>");
  });

  it("with a true total, shares are of that total and the remainder is its own row", () => {
    // The rows are the top 2 of a longer list: 300 + 100 of 1,000 events.
    const top = [
      { key: "user", label: "User", value: 300 },
      { key: "workflow", label: "Workflow", value: 100 },
    ];
    const m = html(<BreakdownList items={top} total={1000} otherLabel="Other areas" label="Audit events by area" testId="areas" />);
    expect(text(m)).toBe("User 300 30% Workflow 100 10% Other areas 600 60%");
    expect(m).toContain('data-testid="areas-row-__other"');
    // without the total the same rows would wrongly read 75% and 25%
    expect(text(html(<BreakdownList items={top} label="x" />))).toBe("User 300 75% Workflow 100 25%");
  });

  it("adds no remainder row when the rows already make up the total", () => {
    const rows = [{ key: "a", label: "A", value: 6 }, { key: "b", label: "B", value: 4 }];
    expect(text(html(<BreakdownList items={rows} total={10} label="x" />))).toBe("A 6 60% B 4 40%");
    // a total smaller than the rows (a count that moved between two reads) never yields a negative remainder
    expect(text(html(<BreakdownList items={rows} total={8} label="x" />))).toBe("A 6 60% B 4 40%");
    // rows that are all zero but a non-zero total: everything is "other"
    expect(text(html(<BreakdownList items={[]} total={5} otherLabel="Other types" label="x" />))).toBe("Other types 5 100%");
  });

  it("uses a row's own colour for its swatch and bar when one is given", () => {
    const m = html(<BreakdownList items={[{ key: "active", label: "Active", value: 5, color: "hsl(var(--success))" }]} label="x" />);
    expect(m.match(/hsl\(var\(--success\)\)/g)).toHaveLength(2);
  });
});

describe("SegmentedBar", () => {
  it("describes every part in its accessible name and draws only the non-zero parts", () => {
    const m = html(
      <SegmentedBar
        label="Subscriptions by status"
        items={[
          { key: "active", label: "Active", value: 25, color: "hsl(var(--success))" },
          { key: "trialing", label: "Trialing", value: 10, color: "hsl(var(--info))" },
          { key: "expired", label: "Expired", value: 0 },
        ]}
      />,
    );
    expect(m).toContain('role="img"');
    expect(m).toContain('aria-label="Subscriptions by status: Active 25 (71%), Trialing 10 (29%)"');
    expect(m.match(/<span/g)).toHaveLength(2);
    expect(m).toContain("flex-grow:25");
    expect(m).toContain("flex-grow:10");
  });

  it("says so when there is no data", () => {
    const m = html(<SegmentedBar label="Subscriptions by status" items={[{ key: "a", label: "Active", value: 0 }]} />);
    expect(m).toContain('aria-label="Subscriptions by status: no data"');
    expect(m).not.toContain("<span");
  });
});

describe("DataTable and ChartCard", () => {
  const table = {
    caption: "Card scans per period",
    columns: [
      { key: "bucket", label: "Day" },
      { key: "scans", label: "Card scans", align: "right" as const },
    ],
    rows: [
      { bucket: "Nov 18, 2026", scans: "12" },
      { bucket: "Nov 19, 2026", scans: "7" },
    ],
  };

  it("renders a captioned, keyboard-reachable table with column headers", () => {
    const m = html(<DataTable table={table} />);
    expect(m).toContain('role="region"');
    expect(m).toContain('aria-label="Card scans per period"');
    expect(m).toContain('tabindex="0"');
    expect(m).toContain("<caption");
    expect(m.match(/scope="col"/g)).toHaveLength(2);
    expect(text(m)).toBe("Card scans per period Day Card scans Nov 18, 2026 12 Nov 19, 2026 7");
  });

  it("caps its height only in the compact (chart table view) form", () => {
    expect(html(<DataTable table={table} compact />)).toContain("max-h-[320px]");
    expect(html(<DataTable table={table} />)).not.toContain("max-h-[320px]");
  });

  it("a chart card names its region, starts on the chart, and offers the table view", () => {
    const m = html(
      <ChartCard title="Card scans" description="Cards captured across all companies" table={table} testId="scans">
        <p>chart body</p>
      </ChartCard>,
    );
    expect(m).toMatch(/<section aria-labelledby="([^"]+)"[^>]*data-testid="scans"/);
    expect(m).toMatch(/<h3 id="[^"]+"[^>]*>Card scans<\/h3>/);
    expect(text(m)).toContain("chart body");
    expect(m).not.toContain("<table");
    expect(m).toMatch(/<button[^>]*aria-pressed="true"[^>]*>Chart<\/button>/);
    expect(m).toMatch(/<button[^>]*aria-pressed="false"[^>]*>Table<\/button>/);
    // the selected view is white text on the brand orange
    expect(m).toMatch(/aria-pressed="true"[^>]*class="[^"]*bg-primary text-primary-foreground/);
  });

  it("offers no view switch when there is no table twin", () => {
    const m = html(
      <ChartCard title="By status" badge={<span>As of now</span>} footer="32 of 41">
        <p>body</p>
      </ChartCard>,
    );
    expect(m).not.toContain("<button");
    expect(text(m)).toBe("By status As of now body 32 of 41");
  });
});

describe("TrendChart", () => {
  const series2 = [
    { key: "paid", label: "Successful", color: "hsl(var(--chart-2))" },
    { key: "failed", label: "Failed", color: "hsl(var(--chart-4))" },
  ];

  it("replaces the plot with the empty message when every value is zero", () => {
    const m = html(<TrendChart ariaLabel="Payments over time" data={[{ bucket: "2026-11-18", paid: 0, failed: 0 }]} series={series2} kind="bar" empty={<p>No payment notifications.</p>} />);
    expect(m).toContain('data-testid="chart-empty"');
    expect(text(m)).toBe("No payment notifications.");
    expect(m).not.toContain("<figure");
  });

  it("names the figure and always shows a legend for two or more series", () => {
    const m = html(<TrendChart ariaLabel="Payments over time" data={[{ bucket: "2026-11-18", paid: 2, failed: 1 }]} series={series2} kind="bar" stacked />);
    expect(m).toContain('<figure aria-label="Payments over time"');
    expect(m).toContain('data-testid="chart-legend"');
    expect(text(m)).toContain("Successful Failed");
  });

  it("needs no legend for a single series — the card title names it", () => {
    const m = html(<TrendChart ariaLabel="Card scans over time" data={[{ bucket: "2026-11-18", scans: 4 }]} series={[{ key: "scans", label: "Card scans", color: "hsl(var(--chart-1))" }]} />);
    expect(m).toContain("<figure");
    expect(m).not.toContain('data-testid="chart-legend"');
  });

  it("legend text wears a text colour; only the swatch carries the series colour", () => {
    const m = html(<ChartLegend series={series2} kind="line" />);
    expect(m).toMatch(/<ul class="[^"]*text-muted-foreground/);
    expect(m.match(/background-color:hsl\(var\(--chart-[24]\)\)/g)).toHaveLength(2);
    expect(m).not.toMatch(/<li[^>]*style=/);
    expect(m.match(/aria-hidden="true"/g)).toHaveLength(2);
  });
});
