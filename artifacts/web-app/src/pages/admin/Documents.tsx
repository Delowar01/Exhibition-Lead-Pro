import { useMemo, useState } from "react";
import {
  useListDocuments,
  useGetDocumentCategories,
  type Document,
  type DocumentEntityType,
} from "@workspace/api-client-react";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ENTITY_META,
  DocumentRow,
  UploadDialog,
  useDocumentPermissions,
  useDocumentsController,
} from "@/components/DocumentsPanel";
import {
  FolderTree,
  List as ListIcon,
  Upload,
  Search,
  FileText,
  ChevronLeft,
} from "lucide-react";

const ENTITY_TYPES: DocumentEntityType[] = [
  "company",
  "contact",
  "lead",
  "event",
];

export default function AdminDocuments() {
  const { user } = useAuth();
  const perms = useDocumentPermissions();

  const [view, setView] = useState<"folders" | "list">("folders");
  const [openFolder, setOpenFolder] = useState<DocumentEntityType | null>(null);
  const [search, setSearch] = useState("");
  const [entityFilter, setEntityFilter] = useState<string>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [showDeleted, setShowDeleted] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);

  const { data: catalog } = useGetDocumentCategories();
  const controller = useDocumentsController(catalog);

  const { data, isLoading } = useListDocuments({
    includeDeleted: showDeleted,
    limit: 500,
  });

  const allDocs = data?.documents ?? [];

  const categoryOptions = useMemo(() => {
    if (!catalog) return [];
    if (entityFilter !== "all")
      return catalog[entityFilter as DocumentEntityType] ?? [];
    return Array.from(new Set(ENTITY_TYPES.flatMap((t) => catalog[t] ?? [])));
  }, [catalog, entityFilter]);

  const filtered = useMemo(() => {
    let rows = allDocs;
    if (entityFilter !== "all")
      rows = rows.filter((d) => d.entityType === entityFilter);
    if (categoryFilter !== "all")
      rows = rows.filter((d) => d.category === categoryFilter);
    if (fromDate) {
      const t = new Date(fromDate).getTime();
      rows = rows.filter((d) => new Date(d.createdAt).getTime() >= t);
    }
    if (toDate) {
      const t = new Date(toDate).getTime() + 24 * 60 * 60 * 1000;
      rows = rows.filter((d) => new Date(d.createdAt).getTime() <= t);
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      rows = rows.filter(
        (d) =>
          d.name.toLowerCase().includes(q) ||
          d.category.toLowerCase().includes(q) ||
          (d.entityName ?? "").toLowerCase().includes(q) ||
          (d.currentVersion?.fileName ?? "").toLowerCase().includes(q),
      );
    }
    return [...rows].sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }, [allDocs, entityFilter, categoryFilter, fromDate, toDate, search]);

  const countsByEntity = useMemo(() => {
    const map: Record<string, number> = {};
    for (const d of allDocs) {
      if (d.deletedAt && !showDeleted) continue;
      map[d.entityType] = (map[d.entityType] ?? 0) + 1;
    }
    return map;
  }, [allDocs, showDeleted]);

  const folderDocs = useMemo(
    () => (openFolder ? filtered.filter((d) => d.entityType === openFolder) : []),
    [filtered, openFolder],
  );

  const renderRows = (rows: Document[], showEntity: boolean) =>
    isLoading ? (
      <p className="text-sm text-muted-foreground py-10 text-center">
        Loading documents...
      </p>
    ) : rows.length === 0 ? (
      <p className="text-sm text-muted-foreground py-12 text-center">
        No documents found.
      </p>
    ) : (
      <div className="space-y-2">
        {rows.map((doc) => (
          <DocumentRow
            key={doc.id}
            doc={doc}
            showEntity={showEntity}
            perms={perms}
            onPreview={controller.onPreview}
            onDownload={controller.handleDownload}
            onEdit={controller.onEdit}
            onVersions={controller.onVersions}
            onDelete={controller.onDelete}
            onRestore={controller.handleRestore}
          />
        ))}
      </div>
    );

  return (
    <div className="space-y-6 pb-12">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <FileText className="h-7 w-7 text-primary" /> Document Manager
          </h1>
          <p className="text-muted-foreground mt-1">
            Company-wide documents across contacts, leads, events and more.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border border-border overflow-hidden">
            <button
              onClick={() => setView("folders")}
              className={`flex items-center gap-1.5 px-3 py-2 text-sm ${
                view === "folders"
                  ? "bg-primary text-primary-foreground"
                  : "bg-card text-muted-foreground hover:bg-secondary"
              }`}
            >
              <FolderTree className="h-4 w-4" /> Folders
            </button>
            <button
              onClick={() => setView("list")}
              className={`flex items-center gap-1.5 px-3 py-2 text-sm ${
                view === "list"
                  ? "bg-primary text-primary-foreground"
                  : "bg-card text-muted-foreground hover:bg-secondary"
              }`}
            >
              <ListIcon className="h-4 w-4" /> List
            </button>
          </div>
          {perms.canCreate && user?.companyId != null && (
            <Button onClick={() => setUploadOpen(true)}>
              <Upload className="h-4 w-4 mr-2" /> Upload
            </Button>
          )}
        </div>
      </div>

      {/* Filters */}
      <Card className="shadow-sm">
        <CardContent className="p-4 flex flex-col gap-3">
          <div className="flex flex-col lg:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search documents..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select
              value={entityFilter}
              onValueChange={(v) => {
                setEntityFilter(v);
                setCategoryFilter("all");
              }}
            >
              <SelectTrigger className="w-full lg:w-44">
                <SelectValue placeholder="All entities" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All entities</SelectItem>
                {ENTITY_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {ENTITY_META[t].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
              <SelectTrigger className="w-full lg:w-48">
                <SelectValue placeholder="All categories" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {categoryOptions.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
            <div className="flex items-center gap-2">
              <Label className="text-sm text-muted-foreground">From</Label>
              <Input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="w-40"
              />
            </div>
            <div className="flex items-center gap-2">
              <Label className="text-sm text-muted-foreground">To</Label>
              <Input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="w-40"
              />
            </div>
            <div className="flex items-center gap-2 sm:ml-auto">
              <Switch
                id="doc-show-deleted"
                checked={showDeleted}
                onCheckedChange={setShowDeleted}
              />
              <Label
                htmlFor="doc-show-deleted"
                className="text-sm text-muted-foreground"
              >
                Show deleted
              </Label>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Content */}
      {view === "list" ? (
        <Card className="shadow-sm">
          <CardContent className="p-4">{renderRows(filtered, true)}</CardContent>
        </Card>
      ) : openFolder ? (
        <Card className="shadow-sm">
          <CardContent className="p-4 space-y-4">
            <button
              onClick={() => setOpenFolder(null)}
              className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              <ChevronLeft className="h-4 w-4" /> All folders
            </button>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              {(() => {
                const Icon = ENTITY_META[openFolder].icon;
                return <Icon className="h-5 w-5 text-primary" />;
              })()}
              {ENTITY_META[openFolder].label} documents
            </h2>
            {renderRows(folderDocs, true)}
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {ENTITY_TYPES.map((t) => {
            const Icon = ENTITY_META[t].icon;
            return (
              <button
                key={t}
                onClick={() => setOpenFolder(t)}
                className="text-left"
              >
                <Card className="shadow-sm hover:shadow-md hover:border-primary/40 transition-all cursor-pointer h-full">
                  <CardContent className="p-6 flex flex-col gap-3">
                    <div className="w-11 h-11 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                      <Icon className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="font-semibold">{ENTITY_META[t].label}</p>
                      <p className="text-sm text-muted-foreground">
                        {countsByEntity[t] ?? 0} document
                        {(countsByEntity[t] ?? 0) === 1 ? "" : "s"}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              </button>
            );
          })}
        </div>
      )}

      {uploadOpen && user?.companyId != null && (
        <UploadDialog
          open={uploadOpen}
          onOpenChange={setUploadOpen}
          entityType="company"
          entityId={user.companyId}
          categories={catalog?.company ?? []}
          onUploaded={controller.invalidate}
        />
      )}
      {controller.dialogs}
    </div>
  );
}
