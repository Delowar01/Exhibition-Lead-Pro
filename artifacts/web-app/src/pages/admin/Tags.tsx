import React, { useState } from "react";
import {
  useListTags,
  useCreateTag,
  useUpdateTag,
  useDeleteTag,
  getListTagsQueryKey,
  type Tag,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const emptyForm = { name: "", color: "#6366f1", category: "" };

export default function AdminTags() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useListTags();
  const createTag = useCreateTag();
  const updateTag = useUpdateTag();
  const deleteTag = useDeleteTag();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Tag | null>(null);
  const [form, setForm] = useState(emptyForm);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: getListTagsQueryKey() });

  const tags = data?.tags ?? [];

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm);
    setDialogOpen(true);
  };

  const openEdit = (tag: Tag) => {
    setEditing(tag);
    setForm({ name: tag.name, color: tag.color || "#6366f1", category: tag.category || "" });
    setDialogOpen(true);
  };

  const handleSave = () => {
    if (!form.name.trim()) return;
    const payload = {
      name: form.name.trim(),
      color: form.color,
      category: form.category.trim() || null,
    };
    if (editing) {
      updateTag.mutate(
        { id: editing.id, data: payload },
        {
          onSuccess: () => {
            setDialogOpen(false);
            invalidate();
            toast({ title: "Tag updated" });
          },
          onError: () => toast({ title: "Could not update tag", variant: "destructive" }),
        }
      );
    } else {
      createTag.mutate(
        { data: payload },
        {
          onSuccess: () => {
            setDialogOpen(false);
            invalidate();
            toast({ title: "Tag created" });
          },
          onError: () => toast({ title: "Could not create tag", variant: "destructive" }),
        }
      );
    }
  };

  const handleDelete = (tag: Tag) => {
    deleteTag.mutate(
      { id: tag.id },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Tag deleted" });
        },
        onError: () => toast({ title: "Could not delete tag", variant: "destructive" }),
      }
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Tags</h1>
          <p className="text-muted-foreground mt-1">
            Manage tags used to label leads and contacts.
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4 mr-1" /> Add Tag
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">All Tags</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading tags...</p>
          ) : tags.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">No tags yet.</p>
          ) : (
            <div className="space-y-2">
              {tags.map((tag) => (
                <div
                  key={tag.id}
                  className="flex items-center gap-3 p-3 rounded-lg border border-border bg-card"
                >
                  <Badge
                    variant="secondary"
                    className="font-normal"
                    style={
                      tag.color
                        ? { backgroundColor: `${tag.color}20`, color: tag.color }
                        : undefined
                    }
                  >
                    {tag.name}
                  </Badge>
                  {tag.category && (
                    <span className="text-xs text-muted-foreground">{tag.category}</span>
                  )}
                  <div className="flex items-center gap-1 ml-auto">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => openEdit(tag)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive"
                      onClick={() => handleDelete(tag)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Tag" : "Add Tag"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label className="text-xs">Name</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Enterprise"
              />
            </div>
            <div>
              <Label className="text-xs">Color</Label>
              <div className="flex items-center gap-2">
                <Input
                  type="color"
                  value={form.color}
                  onChange={(e) => setForm({ ...form, color: e.target.value })}
                  className="w-16 h-9 p-1"
                />
                <Input
                  value={form.color}
                  onChange={(e) => setForm({ ...form, color: e.target.value })}
                />
              </div>
            </div>
            <div>
              <Label className="text-xs">Category</Label>
              <Input
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                placeholder="Optional"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={!form.name.trim()}>
              {editing ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
