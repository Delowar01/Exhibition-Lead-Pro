export type LifecycleVerb = "publish" | "unpublish" | "archive" | "delete";

/** One vocabulary for every lifecycle confirmation (list rows and the editor). */
export const LIFECYCLE_COPY: Record<LifecycleVerb, { title: string; description: string; confirm: string; success: string; destructive?: boolean }> = {
  publish: {
    title: "Publish and activate this automation?",
    description: "Once published it is active: every future matching CRM event will execute it. It becomes read-only — unpublish it to make changes.",
    confirm: "Publish",
    success: "Automation published — it is now active",
  },
  unpublish: {
    title: "Unpublish this automation?",
    description: "It stops executing for new CRM events and becomes an editable draft. Executions already queued or running finish from their captured snapshots.",
    confirm: "Unpublish",
    success: "Automation unpublished — it is now an editable draft",
  },
  archive: {
    title: "Archive this automation?",
    description: "Archived automations are inactive, read-only history and cannot be reactivated. Executions already queued or running finish from their captured snapshots.",
    confirm: "Archive",
    success: "Automation archived",
    destructive: true,
  },
  delete: {
    title: "Delete this draft?",
    description: "The draft is removed permanently. Run history from earlier published revisions is kept.",
    confirm: "Delete draft",
    success: "Draft deleted",
    destructive: true,
  },
};
