import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";

/** Compact, accessible page control shared by the automation and run lists. */
export function Paginator({
  page,
  pageSize,
  total,
  onPageChange,
  disabled,
  testId = "paginator",
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  disabled?: boolean;
  testId?: string;
}) {
  const pages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <nav className="flex flex-wrap items-center justify-between gap-2" aria-label="Pagination" data-testid={testId}>
      <p className="text-xs text-muted-foreground tabular-nums" data-testid={`${testId}-summary`}>
        {total === 0 ? "No results" : `Showing ${from}–${to} of ${total}`}
      </p>
      <div className="flex items-center gap-1">
        <Button type="button" variant="outline" size="sm" onClick={() => onPageChange(page - 1)} disabled={disabled || page <= 1} aria-label="Previous page" data-testid={`${testId}-prev`}>
          <ChevronLeft className="h-4 w-4 rtl:rotate-180" aria-hidden="true" />
        </Button>
        <span className="px-2 text-xs text-muted-foreground tabular-nums" aria-live="polite">
          Page {page} of {pages}
        </span>
        <Button type="button" variant="outline" size="sm" onClick={() => onPageChange(page + 1)} disabled={disabled || page >= pages} aria-label="Next page" data-testid={`${testId}-next`}>
          <ChevronRight className="h-4 w-4 rtl:rotate-180" aria-hidden="true" />
        </Button>
      </div>
    </nav>
  );
}
