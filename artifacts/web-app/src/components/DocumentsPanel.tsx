import React, { useCallback, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListDocuments,
  useGetDocumentCategories,
  useRequestDocumentUploadUrl,
  useCreateDocument,
  useUpdateDocument,
  useDeleteDocument,
  useRestoreDocument,
  useAddDocumentVersion,
  useListDocumentVersions,
  getListDocumentVersionsQueryKey,
  getGetDocumentQueryKey,
  getDocumentDownloadUrl,
  getDocumentVersionDownloadUrl,
  type Document,
  type DocumentVersion,
  type DocumentEntityType,
  type DocumentCategoryCatalog,
} from "@workspace/api-client-react";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Building2,
  Contact as ContactIcon,
  Target,
  Calendar,
  FileText,
  FileImage,
  FileType2,
  FileSpreadsheet,
  Upload,
  Download,
  Eye,
  Pencil,
  Trash2,
  RotateCcw,
  History,
  MoreVertical,
  Loader2,
  UploadCloud,
  Clock,
  User as UserIcon,
} from "lucide-react";
import { format, parseISO } from "date-fns";

// ── Entity metadata ──────────────────────────────────────────────────────────
export const ENTITY_META: Record<
  DocumentEntityType,
  { label: string; icon: typeof Building2 }
> = {
  company: { label: "Company", icon: Building2 },
  contact: { label: "Contact", icon: ContactIcon },
  lead: { label: "Lead / Opportunity", icon: Target },
  event: { label: "Event", icon: Calendar },
};

// ── Permissions ──────────────────────────────────────────────────────────────
export function useDocumentPermissions() {
  const { user } = useAuth();
  const isFull = user?.role === "primary_admin" || user?.role === "platform_owner";
  const granted = (user?.permissions?.documents as string[] | undefined) ?? [];
  const has = (action: string) => isFull || granted.includes(action);
  return {
    canView: true,
    canCreate: has("create"),
    canEdit: has("edit"),
    canDelete: has("delete"),
  };
}

// ── Formatting helpers ───────────────────────────────────────────────────────
export function formatFileSize(bytes?: number | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function fmtDateTime(v?: string | Date | null): string {
  if (!v) return "";
  try {
    const d = typeof v === "string" ? parseISO(v) : v;
    return format(d, "MMM d, yyyy h:mm a");
  } catch {
    return String(v);
  }
}

export function FileIcon({
  mimeType,
  className = "h-5 w-5",
}: {
  mimeType?: string | null;
  className?: string;
}) {
  const mime = mimeType ?? "";
  if (mime.startsWith("image/"))
    return <FileImage className={`${className} text-purple-500`} />;
  if (mime === "application/pdf")
    return <FileType2 className={`${className} text-red-500`} />;
  if (
    mime.includes("spreadsheet") ||
    mime.includes("excel") ||
    mime === "text/csv"
  )
    return <FileSpreadsheet className={`${className} text-green-600`} />;
  return <FileText className={`${className} text-blue-500`} />;
}

function canPreview(mimeType?: string | null): boolean {
  const mime = mimeType ?? "";
  return mime.startsWith("image/") || mime === "application/pdf";
}

// ── Storage upload (presigned PUT → GCS) ─────────────────────────────────────
export interface UploadedFileMeta {
  objectPath: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
}

export function useDocumentUpload() {
  const requestUrl = useRequestDocumentUploadUrl();
  const upload = useCallback(
    async (file: File): Promise<UploadedFileMeta> => {
      const contentType = file.type || "application/octet-stream";
      const { uploadURL, objectPath } = await requestUrl.mutateAsync({
        data: { fileName: file.name, contentType, size: file.size },
      });
      const putRes = await fetch(uploadURL, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: file,
      });
      if (!putRes.ok) {
        throw new Error(`Upload failed (${putRes.status})`);
      }
      return {
        objectPath,
        fileName: file.name,
        fileSize: file.size,
        mimeType: contentType,
      };
    },
    [requestUrl],
  );
  return { upload };
}

// ── Download / preview ───────────────────────────────────────────────────────
async function fetchSignedUrl(
  documentId: number,
  versionId?: number,
): Promise<{ url: string; fileName: string; mimeType: string }> {
  return versionId != null
    ? getDocumentVersionDownloadUrl(documentId, versionId)
    : getDocumentDownloadUrl(documentId);
}

export async function forceDownload(url: string, fileName: string) {
  try {
    const res = await fetch(url);
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    const a = window.document.createElement("a");
    a.href = objUrl;
    a.download = fileName;
    window.document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objUrl);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

// ── Upload dialog ────────────────────────────────────────────────────────────
function UploadDialog({
  open,
  onOpenChange,
  entityType,
  entityId,
  categories,
  initialFiles,
  onUploaded,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  entityType: DocumentEntityType;
  entityId: number;
  categories: string[];
  initialFiles?: File[];
  onUploaded: () => void;
}) {
  const { toast } = useToast();
  const { upload } = useDocumentUpload();
  const createDocument = useCreateDocument();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [files, setFiles] = useState<File[]>(initialFiles ?? []);
  const [category, setCategory] = useState<string>(categories[0] ?? "");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  React.useEffect(() => {
    if (open) {
      setFiles(initialFiles ?? []);
      setCategory((prev) => prev || categories[0] || "");
      setName("");
      setDescription("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleSubmit = async () => {
    if (files.length === 0) {
      toast({ title: "Select at least one file", variant: "destructive" });
      return;
    }
    if (!category) {
      toast({ title: "Choose a category", variant: "destructive" });
      return;
    }
    setBusy(true);
    let succeeded = 0;
    try {
      for (const file of files) {
        const meta = await upload(file);
        await createDocument.mutateAsync({
          data: {
            entityType,
            entityId,
            category,
            name: files.length === 1 && name.trim() ? name.trim() : null,
            description: description.trim() || null,
            objectPath: meta.objectPath,
            fileName: meta.fileName,
            fileSize: meta.fileSize,
            mimeType: meta.mimeType,
            label: "V1",
          },
        });
        succeeded++;
      }
      toast({
        title:
          succeeded > 1
            ? `${succeeded} documents uploaded`
            : "Document uploaded",
      });
      onUploaded();
      onOpenChange(false);
    } catch (err) {
      toast({
        title: "Upload failed",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Upload Documents</DialogTitle>
          <DialogDescription>
            Attach files to this {ENTITY_META[entityType].label.toLowerCase()}.
            Files are stored securely in object storage.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const dropped = Array.from(e.dataTransfer.files);
              if (dropped.length) setFiles(dropped);
            }}
            onClick={() => fileInputRef.current?.click()}
            className={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 cursor-pointer transition-colors ${
              dragOver
                ? "border-primary bg-primary/5"
                : "border-border hover:border-primary/50"
            }`}
          >
            <UploadCloud className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm font-medium">
              Drag &amp; drop files here, or click to browse
            </p>
            <p className="text-xs text-muted-foreground">
              Max 25 MB per file
            </p>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                const selected = Array.from(e.target.files ?? []);
                if (selected.length) setFiles(selected);
              }}
            />
          </div>

          {files.length > 0 && (
            <div className="space-y-1 max-h-32 overflow-y-auto">
              {files.map((f, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 text-sm bg-secondary/50 rounded px-2 py-1"
                >
                  <FileIcon mimeType={f.type} className="h-4 w-4" />
                  <span className="flex-1 truncate">{f.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatFileSize(f.size)}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="grid gap-2">
            <Label>Category</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger>
                <SelectValue placeholder="Select a category" />
              </SelectTrigger>
              <SelectContent>
                {categories.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {files.length === 1 && (
            <div className="grid gap-2">
              <Label>Display name (optional)</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={files[0]?.name}
              />
            </div>
          )}

          <div className="grid gap-2">
            <Label>Description (optional)</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Short description"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Upload
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Edit (rename / move category / description) dialog ───────────────────────
function EditDialog({
  doc,
  categories,
  onOpenChange,
  onSaved,
}: {
  doc: Document | null;
  categories: string[];
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const updateDocument = useUpdateDocument();
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");

  React.useEffect(() => {
    if (doc) {
      setName(doc.name);
      setCategory(doc.category);
      setDescription(doc.description ?? "");
    }
  }, [doc]);

  const handleSave = () => {
    if (!doc) return;
    if (!name.trim()) {
      toast({ title: "Name cannot be empty", variant: "destructive" });
      return;
    }
    updateDocument.mutate(
      {
        id: doc.id,
        data: {
          name: name.trim(),
          category,
          description: description.trim() || null,
        },
      },
      {
        onSuccess: () => {
          toast({ title: "Document updated" });
          onSaved();
          onOpenChange(false);
        },
        onError: () =>
          toast({ title: "Update failed", variant: "destructive" }),
      },
    );
  };

  return (
    <Dialog open={!!doc} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Document</DialogTitle>
          <DialogDescription>
            Rename, move to another category, or update the description.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-2">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label>Category (move)</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {categories.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label>Description</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={updateDocument.isPending}>
            {updateDocument.isPending && (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            )}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Preview dialog ───────────────────────────────────────────────────────────
function PreviewDialog({
  target,
  onOpenChange,
}: {
  target: { documentId: number; versionId?: number; name: string } | null;
  onOpenChange: (v: boolean) => void;
}) {
  const { toast } = useToast();
  const [state, setState] = useState<{
    url: string;
    fileName: string;
    mimeType: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);

  React.useEffect(() => {
    let active = true;
    if (target) {
      setLoading(true);
      setState(null);
      fetchSignedUrl(target.documentId, target.versionId)
        .then((res) => {
          if (active) setState(res);
        })
        .catch(() => {
          if (active) {
            toast({ title: "Could not load preview", variant: "destructive" });
            onOpenChange(false);
          }
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="truncate pr-8">
            {target?.name ?? "Preview"}
          </DialogTitle>
        </DialogHeader>
        <div className="min-h-[300px] flex items-center justify-center bg-secondary/30 rounded-md overflow-hidden">
          {loading && (
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          )}
          {!loading && state && state.mimeType.startsWith("image/") && (
            <img
              src={state.url}
              alt={state.fileName}
              className="max-h-[70vh] max-w-full object-contain"
            />
          )}
          {!loading && state && state.mimeType === "application/pdf" && (
            <iframe
              src={state.url}
              title={state.fileName}
              className="w-full h-[70vh] bg-white"
            />
          )}
          {!loading &&
            state &&
            !canPreview(state.mimeType) && (
              <div className="flex flex-col items-center gap-3 p-8 text-center">
                <FileIcon mimeType={state.mimeType} className="h-12 w-12" />
                <p className="text-sm text-muted-foreground">
                  Preview is not available for this file type.
                </p>
                <Button
                  onClick={() => forceDownload(state.url, state.fileName)}
                >
                  <Download className="h-4 w-4 mr-2" /> Download
                </Button>
              </div>
            )}
        </div>
        {state && (
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => forceDownload(state.url, state.fileName)}
            >
              <Download className="h-4 w-4 mr-2" /> Download
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Version history dialog ───────────────────────────────────────────────────
function VersionHistoryDialog({
  doc,
  onOpenChange,
  onChanged,
  canEdit,
  onPreview,
}: {
  doc: Document | null;
  onOpenChange: (v: boolean) => void;
  onChanged: () => void;
  canEdit: boolean;
  onPreview: (t: {
    documentId: number;
    versionId?: number;
    name: string;
  }) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { upload } = useDocumentUpload();
  const addVersion = useAddDocumentVersion();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState("");

  const { data, isLoading } = useListDocumentVersions(doc?.id ?? 0, {
    query: {
      enabled: !!doc,
      queryKey: getListDocumentVersionsQueryKey(doc?.id ?? 0),
    },
  });

  const versions = useMemo(
    () =>
      [...(data?.versions ?? [])].sort(
        (a, b) => b.versionNumber - a.versionNumber,
      ),
    [data],
  );

  const handleAddVersion = async (file: File) => {
    if (!doc) return;
    setBusy(true);
    try {
      const meta = await upload(file);
      await addVersion.mutateAsync({
        id: doc.id,
        data: {
          objectPath: meta.objectPath,
          fileName: meta.fileName,
          fileSize: meta.fileSize,
          mimeType: meta.mimeType,
          label: label.trim() || null,
        },
      });
      queryClient.invalidateQueries({
        queryKey: getListDocumentVersionsQueryKey(doc.id),
      });
      queryClient.invalidateQueries({
        queryKey: getGetDocumentQueryKey(doc.id),
      });
      setLabel("");
      toast({ title: "New version added" });
      onChanged();
    } catch (err) {
      toast({
        title: "Failed to add version",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!doc} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="truncate pr-8">
            Version History{doc ? ` — ${doc.name}` : ""}
          </DialogTitle>
          <DialogDescription>
            Every upload is preserved. Previous versions are never overwritten.
          </DialogDescription>
        </DialogHeader>

        {canEdit && (
          <div className="flex items-end gap-2 border-b border-border pb-4">
            <div className="flex-1 grid gap-1.5">
              <Label className="text-xs">Version label (optional)</Label>
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. Final, Signed Copy"
                disabled={busy}
              />
            </div>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleAddVersion(f);
                e.target.value = "";
              }}
            />
            <Button
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
            >
              {busy ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Upload className="h-4 w-4 mr-2" />
              )}
              New Version
            </Button>
          </div>
        )}

        <div className="max-h-[50vh] overflow-y-auto space-y-2">
          {isLoading ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              Loading versions...
            </p>
          ) : versions.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No versions found.
            </p>
          ) : (
            versions.map((v: DocumentVersion) => {
              const isCurrent = v.id === doc?.currentVersionId;
              return (
                <div
                  key={v.id}
                  className="flex items-center gap-3 rounded-md border border-border p-3"
                >
                  <FileIcon mimeType={v.mimeType} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">
                        V{v.versionNumber}
                        {v.label ? ` · ${v.label}` : ""}
                      </span>
                      {isCurrent && (
                        <Badge variant="secondary" className="text-[10px]">
                          Current
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground truncate">
                      {v.fileName} · {formatFileSize(v.fileSize)}
                    </p>
                    <p className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {fmtDateTime(v.uploadedAt)}
                      {v.uploadedByName ? ` · ${v.uploadedByName}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    {canPreview(v.mimeType) && doc && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() =>
                          onPreview({
                            documentId: doc.id,
                            versionId: v.id,
                            name: `${doc.name} · V${v.versionNumber}`,
                          })
                        }
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={async () => {
                        if (!doc) return;
                        const res = await fetchSignedUrl(doc.id, v.id);
                        forceDownload(res.url, res.fileName);
                      }}
                    >
                      <Download className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Document row ─────────────────────────────────────────────────────────────
export function DocumentRow({
  doc,
  showEntity,
  perms,
  onPreview,
  onDownload,
  onEdit,
  onVersions,
  onDelete,
  onRestore,
}: {
  doc: Document;
  showEntity?: boolean;
  perms: ReturnType<typeof useDocumentPermissions>;
  onPreview: (doc: Document) => void;
  onDownload: (doc: Document) => void;
  onEdit: (doc: Document) => void;
  onVersions: (doc: Document) => void;
  onDelete: (doc: Document) => void;
  onRestore: (doc: Document) => void;
}) {
  const isDeleted = !!doc.deletedAt;
  const mime = doc.currentVersion?.mimeType;
  const EntityIcon = ENTITY_META[doc.entityType]?.icon ?? FileText;
  return (
    <div
      className={`flex items-center gap-3 rounded-md border border-border p-3 transition-colors hover:bg-secondary/40 ${
        isDeleted ? "opacity-60" : ""
      }`}
    >
      <FileIcon mimeType={mime} className="h-6 w-6 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => onPreview(doc)}
            className="text-sm font-medium truncate hover:text-primary hover:underline text-left"
          >
            {doc.name}
          </button>
          <Badge variant="outline" className="text-[10px]">
            {doc.category}
          </Badge>
          {(doc.versionCount ?? 0) > 1 && (
            <Badge variant="secondary" className="text-[10px]">
              {doc.versionCount} versions
            </Badge>
          )}
          {isDeleted && (
            <Badge
              variant="outline"
              className="text-[10px] text-red-600 border-red-200 bg-red-50"
            >
              Deleted
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1.5 flex-wrap">
          {showEntity && (
            <>
              <span className="flex items-center gap-1">
                <EntityIcon className="h-3 w-3" />
                {doc.entityName || ENTITY_META[doc.entityType]?.label}
              </span>
              <span className="text-border">·</span>
            </>
          )}
          <span>{formatFileSize(doc.currentVersion?.fileSize)}</span>
          <span className="text-border">·</span>
          <span className="flex items-center gap-1">
            <UserIcon className="h-3 w-3" />
            {doc.currentVersion?.uploadedByName || doc.createdByName || "—"}
          </span>
          <span className="text-border">·</span>
          <span>{fmtDateTime(doc.currentVersion?.uploadedAt ?? doc.createdAt)}</span>
        </p>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon">
            <MoreVertical className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onClick={() => onPreview(doc)}>
            <Eye className="h-4 w-4 mr-2" /> Preview
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onDownload(doc)}>
            <Download className="h-4 w-4 mr-2" /> Download
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onVersions(doc)}>
            <History className="h-4 w-4 mr-2" /> Version history
          </DropdownMenuItem>
          {perms.canEdit && !isDeleted && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onEdit(doc)}>
                <Pencil className="h-4 w-4 mr-2" /> Rename / Move
              </DropdownMenuItem>
            </>
          )}
          {isDeleted
            ? perms.canEdit && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => onRestore(doc)}>
                    <RotateCcw className="h-4 w-4 mr-2" /> Restore
                  </DropdownMenuItem>
                </>
              )
            : perms.canDelete && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => onDelete(doc)}
                    className="text-red-600 focus:text-red-600"
                  >
                    <Trash2 className="h-4 w-4 mr-2" /> Delete
                  </DropdownMenuItem>
                </>
              )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// ── Shared documents controller (used by panel + page) ───────────────────────
export function useDocumentsController(catalog?: DocumentCategoryCatalog) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const perms = useDocumentPermissions();
  const deleteDocument = useDeleteDocument();
  const restoreDocument = useRestoreDocument();

  const [previewTarget, setPreviewTarget] = useState<{
    documentId: number;
    versionId?: number;
    name: string;
  } | null>(null);
  const [editDoc, setEditDoc] = useState<Document | null>(null);
  const [versionsDoc, setVersionsDoc] = useState<Document | null>(null);
  const [deleteDoc, setDeleteDoc] = useState<Document | null>(null);

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["/api/documents"] });
  }, [queryClient]);

  const handleDownload = useCallback(
    async (doc: Document) => {
      try {
        const res = await fetchSignedUrl(doc.id);
        forceDownload(res.url, res.fileName);
      } catch {
        toast({ title: "Download failed", variant: "destructive" });
      }
    },
    [toast],
  );

  const handleDeleteConfirmed = useCallback(() => {
    if (!deleteDoc) return;
    deleteDocument.mutate(
      { id: deleteDoc.id },
      {
        onSuccess: () => {
          toast({ title: "Document deleted" });
          invalidate();
          setDeleteDoc(null);
        },
        onError: () => toast({ title: "Delete failed", variant: "destructive" }),
      },
    );
  }, [deleteDoc, deleteDocument, invalidate, toast]);

  const handleRestore = useCallback(
    (doc: Document) => {
      restoreDocument.mutate(
        { id: doc.id },
        {
          onSuccess: () => {
            toast({ title: "Document restored" });
            invalidate();
          },
          onError: () =>
            toast({ title: "Restore failed", variant: "destructive" }),
        },
      );
    },
    [restoreDocument, invalidate, toast],
  );

  const categoriesFor = useCallback(
    (entityType: DocumentEntityType): string[] =>
      catalog ? (catalog[entityType] ?? []) : [],
    [catalog],
  );

  const dialogs = (
    <>
      <PreviewDialog
        target={previewTarget}
        onOpenChange={(v) => !v && setPreviewTarget(null)}
      />
      <EditDialog
        doc={editDoc}
        categories={editDoc ? categoriesFor(editDoc.entityType) : []}
        onOpenChange={(v) => !v && setEditDoc(null)}
        onSaved={invalidate}
      />
      <VersionHistoryDialog
        doc={versionsDoc}
        onOpenChange={(v) => !v && setVersionsDoc(null)}
        onChanged={invalidate}
        canEdit={perms.canEdit}
        onPreview={setPreviewTarget}
      />
      <AlertDialog
        open={!!deleteDoc}
        onOpenChange={(v) => !v && setDeleteDoc(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete document?</AlertDialogTitle>
            <AlertDialogDescription>
              "{deleteDoc?.name}" will be moved to the deleted state. You can
              restore it later by enabling "Show deleted".
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirmed}
              className="bg-red-600 hover:bg-red-700"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );

  return {
    invalidate,
    handleDownload,
    handleRestore,
    onPreview: (doc: Document) =>
      setPreviewTarget({ documentId: doc.id, name: doc.name }),
    onEdit: setEditDoc,
    onVersions: setVersionsDoc,
    onDelete: setDeleteDoc,
    dialogs,
  };
}

// ── Reusable entity-scoped panel (embedded in detail pages) ──────────────────
export interface DocumentsPanelProps {
  entityType: DocumentEntityType;
  entityId: number;
  entityName?: string;
  title?: string;
  className?: string;
}

export default function DocumentsPanel({
  entityType,
  entityId,
  title = "Documents",
  className,
}: DocumentsPanelProps) {
  const perms = useDocumentPermissions();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [showDeleted, setShowDeleted] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [droppedFiles, setDroppedFiles] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);

  const { data: catalog } = useGetDocumentCategories();
  const controller = useDocumentsController(catalog);

  const listParams = {
    entityType,
    entityId,
    includeDeleted: showDeleted,
    limit: 500,
  };
  const { data, isLoading } = useListDocuments(listParams);

  const categories = catalog?.[entityType] ?? [];

  const documents = useMemo(() => {
    let rows = data?.documents ?? [];
    if (category !== "all") rows = rows.filter((d) => d.category === category);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      rows = rows.filter(
        (d) =>
          d.name.toLowerCase().includes(q) ||
          d.category.toLowerCase().includes(q) ||
          (d.currentVersion?.fileName ?? "").toLowerCase().includes(q),
      );
    }
    return [...rows].sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }, [data, category, search]);

  return (
    <Card className={`shadow-sm ${className ?? ""}`}>
      <CardHeader className="pb-3 flex flex-row items-center justify-between">
        <CardTitle className="text-lg flex items-center gap-2">
          <FileText className="h-5 w-5 text-primary" />
          {title}
          <span className="text-sm font-normal text-muted-foreground">
            ({data?.total ?? 0})
          </span>
        </CardTitle>
        {perms.canCreate && (
          <Button
            size="sm"
            onClick={() => {
              setDroppedFiles([]);
              setUploadOpen(true);
            }}
          >
            <Upload className="h-4 w-4 mr-2" /> Upload
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col sm:flex-row gap-3">
          <Input
            placeholder="Search documents..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1"
          />
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger className="w-full sm:w-52">
              <SelectValue placeholder="All categories" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex items-center gap-2">
            <Switch
              id={`show-deleted-${entityType}-${entityId}`}
              checked={showDeleted}
              onCheckedChange={setShowDeleted}
            />
            <Label
              htmlFor={`show-deleted-${entityType}-${entityId}`}
              className="text-sm text-muted-foreground whitespace-nowrap"
            >
              Show deleted
            </Label>
          </div>
        </div>

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
            className={`rounded-lg border-2 border-dashed py-4 text-center text-sm transition-colors ${
              dragOver
                ? "border-primary bg-primary/5 text-primary"
                : "border-border text-muted-foreground"
            }`}
          >
            Drag &amp; drop files here to upload
          </div>
        )}

        <div className="space-y-2">
          {isLoading ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              Loading documents...
            </p>
          ) : documents.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No documents yet.
            </p>
          ) : (
            documents.map((doc) => (
              <DocumentRow
                key={doc.id}
                doc={doc}
                perms={perms}
                onPreview={controller.onPreview}
                onDownload={controller.handleDownload}
                onEdit={controller.onEdit}
                onVersions={controller.onVersions}
                onDelete={controller.onDelete}
                onRestore={controller.handleRestore}
              />
            ))
          )}
        </div>
      </CardContent>

      {uploadOpen && (
        <UploadDialog
          open={uploadOpen}
          onOpenChange={setUploadOpen}
          entityType={entityType}
          entityId={entityId}
          categories={categories}
          initialFiles={droppedFiles}
          onUploaded={controller.invalidate}
        />
      )}
      {controller.dialogs}
    </Card>
  );
}

export { UploadDialog };
