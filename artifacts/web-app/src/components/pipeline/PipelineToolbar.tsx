import { useState } from "react";
import { Link } from "wouter";
import {
  Search,
  SlidersHorizontal,
  Columns3,
  Bookmark,
  BookmarkPlus,
  Trash2,
  Download,
  Upload,
  Plus,
  LayoutGrid,
  Table as TableIcon,
  Group,
  X,
} from "lucide-react";
import type { SavedSearch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { BRAND, LEAD_COLUMNS, type GroupBy, type ViewMode } from "./utils";

interface PipelineToolbarProps {
  search: string;
  onSearch: (v: string) => void;
  viewMode: ViewMode;
  onViewMode: (v: ViewMode) => void;
  groupBy: GroupBy;
  onGroupBy: (v: GroupBy) => void;
  columnVisibility: Record<string, boolean>;
  onToggleColumn: (id: string, visible: boolean) => void;
  onOpenFilters: () => void;
  activeFilterCount: number;
  onResetFilters: () => void;
  savedViews: SavedSearch[];
  currentViewName: string | null;
  onApplyView: (v: SavedSearch) => void;
  onDeleteView: (id: number) => void;
  onSaveView: (name: string) => void;
  canImportLeads: boolean;
  canExport: boolean;
  onImport: () => void;
  onExport: () => void;
  newLeadHref: string;
}

export function PipelineToolbar(props: PipelineToolbarProps) {
  const [viewName, setViewName] = useState("");
  const [saveOpen, setSaveOpen] = useState(false);

  const isTable = props.viewMode === "table";

  return (
    <div className="flex flex-shrink-0 flex-wrap items-center gap-2">
      <div className="relative min-w-[200px] flex-1">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          data-testid="input-pipeline-search"
          placeholder="Search leads, companies, owners..."
          value={props.search}
          onChange={(e) => props.onSearch(e.target.value)}
          className="pl-9"
        />
        {props.search && (
          <button
            type="button"
            onClick={() => props.onSearch("")}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* View mode toggle */}
      <div className="flex overflow-hidden rounded-md border">
        <button
          type="button"
          data-testid="button-view-table"
          onClick={() => props.onViewMode("table")}
          className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition-colors ${isTable ? "text-white" : "text-muted-foreground hover:bg-muted"}`}
          style={{ backgroundColor: isTable ? BRAND.navy : "transparent" }}
        >
          <TableIcon className="h-4 w-4" />
          <span className="hidden sm:inline">Table</span>
        </button>
        <button
          type="button"
          data-testid="button-view-kanban"
          onClick={() => props.onViewMode("kanban")}
          className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition-colors ${!isTable ? "text-white" : "text-muted-foreground hover:bg-muted"}`}
          style={{ backgroundColor: !isTable ? BRAND.navy : "transparent" }}
        >
          <LayoutGrid className="h-4 w-4" />
          <span className="hidden sm:inline">Board</span>
        </button>
      </div>

      {isTable && (
        <Select value={props.groupBy} onValueChange={(v) => props.onGroupBy(v as GroupBy)}>
          <SelectTrigger className="w-[150px]" data-testid="select-group-by">
            <Group className="mr-1.5 h-4 w-4 text-muted-foreground" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No grouping</SelectItem>
            <SelectItem value="stage">Group by stage</SelectItem>
            <SelectItem value="owner">Group by owner</SelectItem>
            <SelectItem value="team">Group by team</SelectItem>
            <SelectItem value="priority">Group by priority</SelectItem>
          </SelectContent>
        </Select>
      )}

      <Button
        variant="outline"
        onClick={props.onOpenFilters}
        data-testid="button-open-filters"
        className="relative"
      >
        <SlidersHorizontal className="mr-2 h-4 w-4" />
        Filters
        {props.activeFilterCount > 0 && (
          <span
            className="ml-2 rounded-full px-1.5 py-0.5 text-[10px] font-bold text-white"
            style={{ backgroundColor: BRAND.orange }}
          >
            {props.activeFilterCount}
          </span>
        )}
      </Button>

      {isTable && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" data-testid="button-columns">
              <Columns3 className="mr-2 h-4 w-4" />
              <span className="hidden sm:inline">Columns</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel>Toggle columns</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {LEAD_COLUMNS.filter((c) => c.hideable).map((c) => (
              <DropdownMenuCheckboxItem
                key={c.id}
                checked={props.columnVisibility[c.id] !== false}
                onCheckedChange={(v) => props.onToggleColumn(c.id, !!v)}
                onSelect={(e) => e.preventDefault()}
              >
                {c.label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {/* Saved views */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" data-testid="button-saved-views">
            <Bookmark className="mr-2 h-4 w-4" />
            <span className="hidden max-w-[120px] truncate sm:inline">{props.currentViewName || "Views"}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel>Saved views</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {props.savedViews.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">No saved views yet.</div>
          )}
          {props.savedViews.map((v) => (
            <div key={v.id} className="flex items-center">
              <DropdownMenuItem className="flex-1" onClick={() => props.onApplyView(v)}>
                {v.name}
              </DropdownMenuItem>
              <button
                type="button"
                onClick={() => props.onDeleteView(v.id)}
                className="mr-1 rounded p-1 text-muted-foreground hover:text-destructive"
                aria-label={`Delete view ${v.name}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <DropdownMenuSeparator />
          <Popover open={saveOpen} onOpenChange={setSaveOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
                data-testid="button-save-view"
              >
                <BookmarkPlus className="h-4 w-4" />
                Save current view
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-64">
              <div className="space-y-2">
                <Input
                  placeholder="View name"
                  value={viewName}
                  onChange={(e) => setViewName(e.target.value)}
                  data-testid="input-view-name"
                />
                <Button
                  size="sm"
                  className="w-full text-white hover:opacity-90"
                  style={{ backgroundColor: BRAND.orange }}
                  disabled={!viewName.trim()}
                  onClick={() => {
                    props.onSaveView(viewName.trim());
                    setViewName("");
                    setSaveOpen(false);
                  }}
                >
                  Save view
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        </DropdownMenuContent>
      </DropdownMenu>

      {props.activeFilterCount > 0 && (
        <Button variant="ghost" onClick={props.onResetFilters} data-testid="button-clear-filters" className="text-muted-foreground">
          Clear
        </Button>
      )}

      <div className="ml-auto flex items-center gap-2">
        {props.canImportLeads && (
          <Button variant="outline" onClick={props.onImport} data-testid="button-import">
            <Upload className="mr-2 h-4 w-4" />
            <span className="hidden md:inline">Import</span>
          </Button>
        )}
        {props.canExport && (
          <Button variant="outline" onClick={props.onExport} data-testid="button-export">
            <Download className="mr-2 h-4 w-4" />
            <span className="hidden md:inline">Export</span>
          </Button>
        )}
        <Link href={props.newLeadHref}>
          <Button data-testid="button-new-lead" className="text-white hover:opacity-90" style={{ backgroundColor: BRAND.orange }}>
            <Plus className="mr-2 h-4 w-4" />
            New Lead
          </Button>
        </Link>
      </div>
    </div>
  );
}
