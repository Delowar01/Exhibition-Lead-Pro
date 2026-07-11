import React, { useMemo, useState } from "react";
import {
  useListDocuments,
  useGetDocumentCategories,
  type Contact,
  type Document,
} from "@workspace/api-client-react";
import {
  UploadDialog,
  useDocumentsController,
  useDocumentPermissions,
  FileIcon,
  formatFileSize,
  fmtDateTime,
} from "@/components/DocumentsPanel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  Download,
  Eye,
  FileText,
  History,
  Pencil,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  Upload,
  User,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { CardSkeleton, EmptyState, ErrorState, WorkspaceToolbar } from "./shared";

function DocumentDetails({
  doc,
  contact,
  perms,
  controller,
}: {
  doc: Document;
  contact: Contact;
  perms: ReturnType<typeof useDocumentPermissions>;
  controller: ReturnType<typeof useDocumentsController>;
}) {
  const isDeleted = !!doc.deletedAt;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2.5">
        <span className="h-10 w-10 rounded-lg bg-secondary flex items-center justify-center shrink-0">
          <FileIcon mimeType={doc.currentVersion?.mimeType} className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <p className="font-semibold text-sm break-words">{doc.name}</p>
          <p className="text-xs text-muted-foreground capitalize">{doc.category.replace(/_/g, " ")}</p>
        </div>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        {(doc.versionCount ?? 0) > 1 && (
          <Badge variant="secondary" className="text-[10px]">
            {doc.versionCount} versions
          </Badge>
        )}
        {isDeleted && (
          <Badge variant="outline" className="text-[10px] bg-destructive-soft text-destructive border-destructive/25">
            Deleted
          </Badge>
        )}
      </div>
      <dl className="space-y-2 text-sm">
        <div>
          <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">File</dt>
          <dd className="font-medium break-words">
            {doc.currentVersion?.fileName ?? doc.name}
            <span className="text-muted-foreground font-normal">
              {" "}
              · {formatFileSize(doc.currentVersion?.fileSize)}
            </span>
          </dd>
        </div>
        <div>
          <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">Uploaded By</dt>
          <dd className="font-medium flex items-center gap-1.5">
            <User className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            {doc.currentVersion?.uploadedByName || doc.createdByName || "—"}
          </dd>
        </div>
        <div>
          <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">Upload Date</dt>
          <dd className="font-medium">{fmtDateTime(doc.currentVersion?.uploadedAt ?? doc.createdAt)}</dd>
        </div>
        <div>
          <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">Related Contact</dt>
          <dd className="font-medium">
            {`${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim() || "This contact"}
          </dd>
        </div>
        {contact.contactCompany && (
          <div>
            <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">Related Company</dt>
            <dd className="font-medium">{contact.contactCompany}</dd>
          </div>
        )}
      </dl>
      <div className="flex flex-wrap gap-2 pt-1">
        <Button size="sm" onClick={() => controller.onPreview(doc)} data-testid="button-doc-preview">
          <Eye className="h-3.5 w-3.5 mr-1.5" /> Preview
        </Button>
        <Button size="sm" variant="outline" onClick={() => controller.handleDownload(doc)}>
          <Download className="h-3.5 w-3.5 mr-1.5" /> Download
        </Button>
        <Button size="sm" variant="outline" onClick={() => controller.onVersions(doc)} data-testid="button-doc-versions">
          <History className="h-3.5 w-3.5 mr-1.5" /> Versions
        </Button>
        {perms.canEdit && !isDeleted && (
          <Button size="sm" variant="outline" onClick={() => controller.onEdit(doc)}>
            <Pencil className="h-3.5 w-3.5 mr-1.5" /> Rename / Move
          </Button>
        )}
        {isDeleted
          ? perms.canEdit && (
              <Button size="sm" variant="outline" onClick={() => controller.handleRestore(doc)}>
                <RotateCcw className="h-3.5 w-3.5 mr-1.5" /> Restore
              </Button>
            )
          : perms.canDelete && (
              <Button
                size="sm"
                variant="outline"
                className="text-destructive hover:text-destructive"
                onClick={() => controller.onDelete(doc)}
                data-testid="button-doc-delete"
              >
                <Trash2 className="h-3.5 w-3.5 mr-1.5" /> Delete
              </Button>
            )}
      </div>
    </div>
  );
}

export interface DocumentsWorkspaceProps {
  contact: Contact;
}

export default function DocumentsWorkspace({ contact }: DocumentsWorkspaceProps) {
  const contactId = contact.id;
  const perms = useDocumentPermissions();
  const { data: catalog } = useGetDocumentCategories();
  const controller = useDocumentsController(catalog);

  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [showDeleted, setShowDeleted] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [droppedFiles, setDroppedFiles] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);

  const listQ = useListDocuments({
    entityType: "contact",
    entityId: contactId,
    includeDeleted: showDeleted,
    limit: 500,
  });

  const categories = catalog?.contact ?? [];

  const documents = useMemo(() => {
    let rows = listQ.data?.documents ?? [];
    if (category !== "all") rows = rows.filter((d) => d.category === category);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      rows = rows.filter(
        (d) =>
          d.name.toLowerCase().includes(q) ||
          d.category.toLowerCase().includes(q) ||
          (d.currentVersion?.fileName ?? "").toLowerCase().includes(q) ||
          (d.currentVersion?.uploadedByName ?? "").toLowerCase().includes(q),
      );
    }
    return [...rows].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }, [listQ.data, category, search]);

  const selected = documents.find((d) => d.id === selectedId) ?? null;

  const selectDoc = (d: Document) => {
    setSelectedId(d.id);
    if (window.innerWidth < 1024) setMobileDetailOpen(true);
  };

  return (
    <div className="space-y-4">
      <WorkspaceToolbar>
        <div className="relative flex-1 min-w-[150px]">
          <Search className="absolute start-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search documents…"
            className="ps-8 h-9"
            aria-label="Search documents"
            data-testid="input-documents-search"
          />
        </div>
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger className="w-[160px] h-9 shrink-0" data-testid="select-documents-category">
            <SelectValue placeholder="Category" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {categories.map((c) => (
              <SelectItem key={c} value={c} className="capitalize">
                {c.replace(/_/g, " ")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-1.5 shrink-0">
          <Switch id="ws-docs-show-deleted" checked={showDeleted} onCheckedChange={setShowDeleted} />
          <Label htmlFor="ws-docs-show-deleted" className="text-xs text-muted-foreground whitespace-nowrap">
            Show deleted
          </Label>
        </div>
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9 shrink-0"
          onClick={() => listQ.refetch()}
          aria-label="Refresh documents"
        >
          <RefreshCw className={cn("h-4 w-4", listQ.isFetching && "animate-spin")} />
        </Button>
        {perms.canCreate && (
          <Button
            size="sm"
            className="shrink-0"
            onClick={() => {
              setDroppedFiles([]);
              setUploadOpen(true);
            }}
            data-testid="button-upload-document"
          >
            <Upload className="h-4 w-4 mr-1.5" /> Upload
          </Button>
        )}
      </WorkspaceToolbar>

      <div className="grid grid-cols-1 lg:grid-cols-[13fr_7fr] gap-5 items-start">
        <div className="space-y-3">
          {perms.canCreate && (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                const files = Array.from(e.dataTransfer.files);
                if (files.length) {
                  setDroppedFiles(files);
                  setUploadOpen(true);
                }
              }}
              className={cn(
                "rounded-xl border-2 border-dashed py-3.5 text-center text-sm transition-colors",
                dragOver ? "border-primary bg-primary/5 text-primary" : "border-border text-muted-foreground",
              )}
            >
              Drag &amp; drop files here to upload
            </div>
          )}

          {listQ.isLoading ? (
            <CardSkeleton rows={5} />
          ) : listQ.isError ? (
            <ErrorState message="Unable to load documents." onRetry={() => listQ.refetch()} />
          ) : documents.length === 0 ? (
            <EmptyState
              icon={<FileText className="h-5 w-5" aria-hidden />}
              headline="No documents available."
              description="Upload proposals, contracts, and other files to keep this relationship deal-ready."
              actions={
                perms.canCreate ? (
                  <Button
                    size="sm"
                    onClick={() => {
                      setDroppedFiles([]);
                      setUploadOpen(true);
                    }}
                    data-testid="button-empty-upload"
                  >
                    <Upload className="h-4 w-4 mr-2" /> Upload Document
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <ul className="space-y-2">
              {documents.map((doc) => {
                const isSelected = doc.id === selectedId;
                const isDeleted = !!doc.deletedAt;
                return (
                  <li key={doc.id}>
                    <button
                      type="button"
                      onClick={() => selectDoc(doc)}
                      aria-pressed={isSelected}
                      className={cn(
                        "w-full text-start rounded-xl border px-3.5 py-2.5 transition-colors flex items-center gap-3",
                        isSelected
                          ? "border-primary/40 bg-primary/5 ring-1 ring-primary/20"
                          : "border-border/60 bg-card hover:bg-secondary/40",
                        isDeleted && "opacity-60",
                      )}
                      data-testid={`document-${doc.id}`}
                    >
                      <span className="h-9 w-9 rounded-lg bg-secondary flex items-center justify-center shrink-0">
                        <FileIcon mimeType={doc.currentVersion?.mimeType} className="h-5 w-5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2 min-w-0">
                          <span className="text-sm font-medium truncate">{doc.name}</span>
                          <Badge variant="outline" className="text-[10px] capitalize shrink-0 hidden sm:inline-flex">
                            {doc.category.replace(/_/g, " ")}
                          </Badge>
                          {(doc.versionCount ?? 0) > 1 && (
                            <Badge variant="secondary" className="text-[10px] shrink-0 hidden md:inline-flex">
                              v{doc.versionCount}
                            </Badge>
                          )}
                          {isDeleted && (
                            <Badge variant="outline" className="text-[10px] shrink-0 bg-destructive-soft text-destructive border-destructive/25">
                              Deleted
                            </Badge>
                          )}
                        </span>
                        <span className="block text-xs text-muted-foreground truncate mt-0.5">
                          {formatFileSize(doc.currentVersion?.fileSize)}
                          {" · "}
                          {doc.currentVersion?.uploadedByName || doc.createdByName || "—"}
                          {" · "}
                          {fmtDateTime(doc.currentVersion?.uploadedAt ?? doc.createdAt)}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Preview panel (desktop) */}
        <aside
          className="hidden lg:block sticky top-20 rounded-2xl border border-border/60 bg-card shadow-sm p-5 min-h-[220px]"
          aria-label="Document preview"
        >
          {selected ? (
            <DocumentDetails doc={selected} contact={contact} perms={perms} controller={controller} />
          ) : (
            <div className="text-center py-10">
              <FileText className="h-8 w-8 text-muted-foreground mx-auto mb-2" aria-hidden />
              <p className="text-sm text-muted-foreground">Select a document to preview its details.</p>
            </div>
          )}
        </aside>
      </div>

      {/* Mobile / tablet detail sheet */}
      <Sheet open={mobileDetailOpen} onOpenChange={setMobileDetailOpen}>
        <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto lg:hidden">
          <SheetHeader>
            <SheetTitle>Document details</SheetTitle>
          </SheetHeader>
          <div className="pt-4">
            {selected && (
              <DocumentDetails doc={selected} contact={contact} perms={perms} controller={controller} />
            )}
          </div>
        </SheetContent>
      </Sheet>

      {uploadOpen && (
        <UploadDialog
          open={uploadOpen}
          onOpenChange={setUploadOpen}
          entityType="contact"
          entityId={contactId}
          categories={categories}
          initialFiles={droppedFiles}
          onUploaded={controller.invalidate}
        />
      )}
      {controller.dialogs}
    </div>
  );
}
