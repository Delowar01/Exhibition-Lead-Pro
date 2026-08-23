import React, { useState } from "react";
import {
  useCreateExport,
  getListExportRunsQueryKey,
  type ExportCreateInput,
  type ExportRunWithUrl,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Download, Lock, Loader2, RotateCcw, FileDown, AlertTriangle } from "lucide-react";
import {
  FORMAT_OPTIONS,
  ExportFilterFields,
  EncryptionMethodSelector,
  cleanFilters,
  humanFileSize,
  triggerDownload,
  type ExportEntity,
  type ExportFileFormat,
  type FilterValues,
  type ZipEncryptionMethod,
} from "./export-shared";

// On-demand Export Center. The optional password lives ONLY in transient
// component state and the single POST body: it is never persisted, never
// logged, never placed in a URL, and is cleared as soon as the request
// completes (success or failure). Downloads always use the server-issued
// signed URL from the response.

export function ExportCenterPanel() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createExport = useCreateExport();

  const [entityType, setEntityType] = useState<ExportEntity>("contact");
  const [fmt, setFmt] = useState<ExportFileFormat>("csv");
  const [filters, setFilters] = useState<FilterValues>({});
  const [protect, setProtect] = useState(false);
  const [password, setPassword] = useState("");
  const [encMethod, setEncMethod] = useState<ZipEncryptionMethod>("aes256");
  const [result, setResult] = useState<ExportRunWithUrl | null>(null);
  const [failed, setFailed] = useState(false);

  const passwordInvalid = protect && password.length < 6;
  const hasFilters = Object.keys(filters).length > 0;

  const switchEntity = (e: ExportEntity) => {
    if (e === entityType) return;
    setEntityType(e);
    setFilters({}); // entity-specific filters do not carry across
    setResult(null);
    setFailed(false);
  };

  const handleGenerate = () => {
    if (passwordInvalid || createExport.isPending) return;
    setResult(null);
    setFailed(false);
    const body: ExportCreateInput = {
      entityType,
      format: fmt,
      filters: cleanFilters(filters),
      passwordProtected: protect,
      password: protect ? password : null,
      // Transient, only meaningful alongside a password; AES-256 is the default.
      ...(protect ? { encryptionMethod: encMethod } : {}),
    };
    createExport.mutate(
      { data: body },
      {
        onSuccess: (run) => {
          setPassword(""); // never keep the password after completion
          setProtect(false);
          setEncMethod("aes256");
          queryClient.invalidateQueries({ queryKey: getListExportRunsQueryKey() });
          if (run.status === "failed") {
            setFailed(true);
            return;
          }
          setResult(run);
        },
        onError: () => {
          setPassword(""); // never keep the password after failure
          setFailed(true);
          toast({ title: "Export failed", description: "The file could not be generated.", variant: "destructive" });
        },
      },
    );
  };

  return (
    <div className="space-y-4" data-testid="export-center-panel">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">New Export</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">What to export</Label>
            <div className="grid grid-cols-2 gap-2 max-w-sm">
              {(["contact", "lead"] as const).map((e) => (
                <button
                  key={e}
                  type="button"
                  data-testid={`export-entity-${e}`}
                  onClick={() => switchEntity(e)}
                  className={`rounded-lg border p-2.5 text-sm font-medium transition-colors ${
                    entityType === e ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border hover:bg-muted/50"
                  }`}
                >
                  {e === "contact" ? "Contacts" : "Leads"}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">Format</Label>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
              {FORMAT_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  data-testid={`export-format-${opt.value}`}
                  onClick={() => setFmt(opt.value)}
                  className={`rounded-lg border p-3 text-left transition-colors ${
                    fmt === opt.value ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border hover:bg-muted/50"
                  }`}
                >
                  <div className="font-medium text-sm">{opt.label}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{opt.hint}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs text-muted-foreground">Filters</Label>
              {hasFilters && (
                <Button variant="ghost" size="sm" className="h-7" onClick={() => setFilters({})}>
                  <RotateCcw className="mr-1.5 h-3 w-3" /> Clear filters
                </Button>
              )}
            </div>
            <ExportFilterFields entityType={entityType} value={filters} onChange={setFilters} />
            <p className="text-xs text-muted-foreground">
              {hasFilters ? "Only records matching these filters are exported." : "No filters — exports all your records (up to 10,000 rows)."}
            </p>
          </div>

          <div className="space-y-2 border-t pt-4">
            <div className="flex items-center gap-2">
              <Checkbox id="export-protect" checked={protect} onCheckedChange={(v) => setProtect(v === true)} />
              <Label htmlFor="export-protect" className="flex items-center gap-1.5 cursor-pointer font-normal">
                <Lock className="h-3.5 w-3.5" /> Password-protect the file
              </Label>
            </div>
            {protect && (
              <div className="pl-6 space-y-3 max-w-md">
                <div className="space-y-1 max-w-sm">
                  <Input
                    type="password"
                    autoComplete="new-password"
                    placeholder="At least 6 characters"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    data-testid="export-password"
                  />
                  <p className="text-xs text-muted-foreground">
                    Delivered as an encrypted ZIP. The password is used once and never stored — keep it safe.
                  </p>
                </div>
                <EncryptionMethodSelector value={encMethod} onChange={setEncMethod} />
              </div>
            )}
          </div>

          <div className="flex justify-end border-t pt-4">
            <Button onClick={handleGenerate} disabled={createExport.isPending || passwordInvalid} data-testid="export-generate">
              {createExport.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
              {createExport.isPending ? "Generating…" : "Generate export"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {failed && (
        <Card className="border-destructive/50" data-testid="export-failed">
          <CardContent className="py-4 flex items-center gap-3">
            <AlertTriangle className="h-5 w-5 text-destructive shrink-0" />
            <div>
              <p className="text-sm font-medium">Export failed</p>
              <p className="text-xs text-muted-foreground">
                The file could not be generated or stored. Try again, or check Export History for details.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {result && (
        <Card className="border-primary/40" data-testid="export-result">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Export ready</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-medium truncate" data-testid="export-result-filename">{result.fileName}</p>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="outline" className="uppercase">{result.format}</Badge>
                <span>{(result.rowCount ?? 0).toLocaleString()} rows</span>
                <span>· {humanFileSize(result.fileSize)}</span>
                {result.passwordProtected && (
                  <span className="flex items-center gap-1"><Lock className="h-3 w-3" /> password-protected</span>
                )}
              </div>
            </div>
            {result.downloadUrl ? (
              <Button size="sm" onClick={() => triggerDownload(result.downloadUrl!)} data-testid="export-result-download">
                <FileDown className="mr-2 h-4 w-4" /> Download
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">Download it from Export History.</p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
