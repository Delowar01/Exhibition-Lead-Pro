import React, { useState } from "react";
import { format, parseISO } from "date-fns";
import {
  useListLeadNotes,
  useCreateLeadNote,
  useUpdateLeadNote,
  useDeleteLeadNote,
  useListLeadNoteComments,
  useCreateLeadNoteComment,
  useUpdateLeadNoteComment,
  useDeleteLeadNoteComment,
  useListLeadNoteHistory,
  getListLeadNotesQueryKey,
  getListLeadNoteCommentsQueryKey,
  getListLeadNoteHistoryQueryKey,
  getListUsersQueryKey,
  useListUsers,
  type LeadNote,
  type LeadNoteComment,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { History as HistoryIcon, Pencil, Trash2, MessageSquare } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { MentionText } from "@/components/collaboration/MentionText";
import { MentionInput, type MentionUser } from "@/components/collaboration/MentionInput";

function fmtDateTime(s?: string | null): string {
  if (!s) return "";
  try {
    return format(parseISO(s), "MMM d, yyyy h:mm a");
  } catch {
    return s;
  }
}

export function LeadNotesTab({ leadId }: { leadId: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useListLeadNotes(leadId, {
    query: { enabled: !!leadId, queryKey: getListLeadNotesQueryKey(leadId) },
  });
  const { data: usersData } = useListUsers({ limit: 100 }, {
    query: { queryKey: getListUsersQueryKey({ limit: 100 }) },
  });
  const createNote = useCreateLeadNote();

  const [body, setBody] = useState("");

  const mentionUsers: MentionUser[] =
    usersData?.users?.map((u) => ({
      id: u.id,
      name: u.name,
    })) || [];

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListLeadNotesQueryKey(leadId) });

  const notes = [...(data?.notes ?? [])].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  const handleCreate = () => {
    if (!body.trim()) return;
    createNote.mutate(
      { id: leadId, data: { body: body.trim() } },
      {
        onSuccess: () => {
          setBody("");
          invalidate();
          toast({ title: "Note added" });
        },
        onError: () => toast({ title: "Could not add note", variant: "destructive" }),
      }
    );
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Add Note</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <MentionInput
            value={body}
            onChange={setBody}
            users={mentionUsers}
            placeholder="Write a note... use @ to mention"
            rows={3}
          />
          <div className="flex justify-end">
            <Button onClick={handleCreate} disabled={!body.trim() || createNote.isPending}>
              Add Note
            </Button>
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading notes...</p>
      ) : notes.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground text-sm">
            No notes yet.
          </CardContent>
        </Card>
      ) : (
        notes.map((note) => (
          <NoteCard key={note.id} note={note} leadId={leadId} mentionUsers={mentionUsers} />
        ))
      )}
    </div>
  );
}

function NoteCard({
  note,
  leadId,
  mentionUsers,
}: {
  note: LeadNote;
  leadId: number;
  mentionUsers: MentionUser[];
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const updateNote = useUpdateLeadNote();
  const deleteNote = useDeleteLeadNote();

  const [isEditing, setIsEditing] = useState(false);
  const [editBody, setEditBody] = useState(note.body);
  const [showHistory, setShowHistory] = useState(false);
  const [showComments, setShowComments] = useState(false);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListLeadNotesQueryKey(leadId) });

  const handleSaveEdit = () => {
    if (!editBody.trim()) return;
    updateNote.mutate(
      { id: note.id, data: { body: editBody.trim() } },
      {
        onSuccess: () => {
          setIsEditing(false);
          invalidate();
          toast({ title: "Note updated" });
        },
        onError: () => toast({ title: "Could not update note", variant: "destructive" }),
      }
    );
  };

  const handleDelete = () => {
    deleteNote.mutate(
      { id: note.id },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Note deleted" });
        },
        onError: () => toast({ title: "Could not delete note", variant: "destructive" }),
      }
    );
  };

  return (
    <Card className="shadow-sm">
      <CardContent className="p-4">
        {isEditing ? (
          <div className="space-y-3">
            <MentionInput value={editBody} onChange={setEditBody} users={mentionUsers} rows={3} />
            <div className="flex gap-2 justify-end">
              <Button variant="outline" size="sm" onClick={() => setIsEditing(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleSaveEdit}>
                Save
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex justify-between items-start gap-4">
            <div className="flex-1 space-y-2">
              <MentionText body={note.body} className="text-sm" />
              <div className="flex items-center gap-3 text-xs text-muted-foreground mt-2">
                <span>
                  {note.userName ? `${note.userName} • ` : ""}
                  {fmtDateTime(note.createdAt)}
                </span>
                {note.updatedAt && (
                  <button
                    onClick={() => setShowHistory(true)}
                    className="flex items-center gap-1 hover:text-foreground transition-colors"
                  >
                    <HistoryIcon className="h-3 w-3" /> Edited
                  </button>
                )}
                <button
                  onClick={() => setShowComments(!showComments)}
                  className="flex items-center gap-1 hover:text-foreground transition-colors"
                >
                  <MessageSquare className="h-3 w-3" />
                  Replies
                </button>
              </div>
            </div>
            {user?.id === note.userId && (
              <div className="flex items-center gap-1 flex-shrink-0">
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setIsEditing(true)}>
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={handleDelete}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
          </div>
        )}

        <NoteHistoryDialog note={showHistory ? note : null} onClose={() => setShowHistory(false)} />

        {showComments && <NoteComments note={note} mentionUsers={mentionUsers} />}
      </CardContent>
    </Card>
  );
}

function NoteComments({ note, mentionUsers }: { note: LeadNote; mentionUsers: MentionUser[] }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const { data, isLoading } = useListLeadNoteComments(note.id, {
    query: { queryKey: getListLeadNoteCommentsQueryKey(note.id) },
  });
  const createComment = useCreateLeadNoteComment();
  const updateComment = useUpdateLeadNoteComment();
  const deleteComment = useDeleteLeadNoteComment();

  const [body, setBody] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editBody, setEditBody] = useState("");

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListLeadNoteCommentsQueryKey(note.id) });

  const comments = [...(data?.comments ?? [])].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  const handleAdd = () => {
    if (!body.trim()) return;
    createComment.mutate(
      { id: note.id, data: { body: body.trim() } },
      {
        onSuccess: () => {
          setBody("");
          invalidate();
        },
        onError: () => toast({ title: "Could not add comment", variant: "destructive" }),
      }
    );
  };

  const handleSaveEdit = (c: LeadNoteComment) => {
    if (!editBody.trim()) return;
    updateComment.mutate(
      { id: c.id, data: { body: editBody.trim() } },
      {
        onSuccess: () => {
          setEditingId(null);
          invalidate();
        },
        onError: () => toast({ title: "Could not update comment", variant: "destructive" }),
      }
    );
  };

  const handleDelete = (c: LeadNoteComment) => {
    deleteComment.mutate(
      { id: c.id },
      {
        onSuccess: invalidate,
        onError: () => toast({ title: "Could not delete comment", variant: "destructive" }),
      }
    );
  };

  return (
    <div className="mt-3 border-t pt-3 space-y-3">
      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading comments...</p>
      ) : comments.length === 0 ? (
        <p className="text-xs text-muted-foreground">No comments yet.</p>
      ) : (
        comments.map((c) => (
          <div key={c.id} className="flex gap-2">
            <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              {(c.userName ?? "?").charAt(0)}
            </span>
            <div className="flex-1 min-w-0">
              {editingId === c.id ? (
                <div className="space-y-2">
                  <MentionInput value={editBody} onChange={setEditBody} users={mentionUsers} rows={2} />
                  <div className="flex gap-2">
                    <Button size="sm" className="h-7 text-xs" onClick={() => handleSaveEdit(c)}>
                      Save
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEditingId(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-start justify-between gap-2">
                    <MentionText body={c.body} className="text-sm" />
                    {user?.id === c.userId && (
                      <div className="flex flex-shrink-0 gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={() => {
                            setEditingId(c.id);
                            setEditBody(c.body);
                          }}
                        >
                          <Pencil className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 text-destructive"
                          onClick={() => handleDelete(c)}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    {c.userName ? `${c.userName} • ` : ""}
                    {fmtDateTime(c.createdAt)}
                  </p>
                </>
              )}
            </div>
          </div>
        ))
      )}
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <MentionInput
            value={body}
            onChange={setBody}
            users={mentionUsers}
            rows={2}
            placeholder="Reply... use @ to mention"
          />
        </div>
        <Button size="sm" onClick={handleAdd} disabled={!body.trim() || createComment.isPending}>
          Reply
        </Button>
      </div>
    </div>
  );
}

function NoteHistoryDialog({ note, onClose }: { note: LeadNote | null; onClose: () => void }) {
  const { data, isLoading } = useListLeadNoteHistory(note?.id ?? 0, {
    query: {
      enabled: !!note,
      queryKey: getListLeadNoteHistoryQueryKey(note?.id ?? 0),
    },
  });
  const history = [...(data?.history ?? [])].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  return (
    <Dialog open={!!note} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit History</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 max-h-[60vh] overflow-y-auto">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading history...</p>
          ) : history.length === 0 ? (
            <p className="text-sm text-muted-foreground">No previous versions.</p>
          ) : (
            history.map((h) => (
              <div key={h.id} className="rounded-md border p-3">
                <MentionText body={h.body} className="text-sm" />
                <p className="text-xs text-muted-foreground mt-2">
                  {h.editedByName ? `${h.editedByName} • ` : ""}
                  {fmtDateTime(h.createdAt)}
                </p>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
