import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  useListUsers,
  getListUsersQueryKey,
  useListTeams,
  getListTeamsQueryKey,
  useListTags,
  getListTagsQueryKey,
  useListPipelineStages,
  getListPipelineStagesQueryKey,
  useListEvents,
  getListEventsQueryKey,
  useListCrmOrganizations,
  getListCrmOrganizationsQueryKey,
} from "@workspace/api-client-react";

/**
 * Human-readable tenant records for the builder's selectors (users, teams,
 * tags, pipeline stages, events, organizations). All lists come from the
 * existing tenant-scoped APIs, fetched once per editor mount and shared through
 * context so every selector shows names — never database ids. Contacts are
 * searched on demand (see fields/ContactPicker.tsx).
 */
export interface Option {
  value: string;
  label: string;
  hint?: string;
}

export interface EntityOptions {
  users: Option[];
  teams: Option[];
  tags: Option[];
  stages: Option[];
  events: Option[];
  organizations: Option[];
  loading: boolean;
}

const EMPTY: EntityOptions = { users: [], teams: [], tags: [], stages: [], events: [], organizations: [], loading: false };
const Ctx = createContext<EntityOptions>(EMPTY);

const USERS = { limit: 200 } as const;
const TEAMS = { limit: 200 } as const;
const EVENTS = { limit: 200 } as const;
const ORGS = { status: "active", limit: 200 } as const;

export function EntityOptionsProvider({ enabled = true, children }: { enabled?: boolean; children: ReactNode }) {
  const users = useListUsers(USERS, { query: { enabled, queryKey: getListUsersQueryKey(USERS), staleTime: 60_000 } });
  const teams = useListTeams(TEAMS, { query: { enabled, queryKey: getListTeamsQueryKey(TEAMS), staleTime: 60_000 } });
  const tags = useListTags({ query: { enabled, queryKey: getListTagsQueryKey(), staleTime: 60_000 } });
  const stages = useListPipelineStages({ query: { enabled, queryKey: getListPipelineStagesQueryKey(), staleTime: 60_000 } });
  const events = useListEvents(EVENTS, { query: { enabled, queryKey: getListEventsQueryKey(EVENTS), staleTime: 60_000 } });
  const orgs = useListCrmOrganizations(ORGS, { query: { enabled, queryKey: getListCrmOrganizationsQueryKey(ORGS), staleTime: 60_000 } });

  const value = useMemo<EntityOptions>(
    () => ({
      users: (users.data?.users ?? []).map((u) => ({ value: String(u.id), label: u.name || u.email, hint: u.email })),
      teams: (teams.data?.teams ?? []).map((t) => ({ value: String(t.id), label: t.name })),
      tags: (tags.data?.tags ?? []).map((t) => ({ value: String(t.id), label: t.name })),
      stages: (stages.data?.stages ?? [])
        .slice()
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((s) => ({ value: s.key, label: s.name, hint: s.key })),
      events: (events.data?.events ?? []).map((e) => ({ value: String(e.id), label: e.name })),
      organizations: (orgs.data?.organizations ?? []).map((o) => ({ value: String(o.id), label: o.name })),
      loading: users.isLoading || teams.isLoading || tags.isLoading || stages.isLoading || events.isLoading || orgs.isLoading,
    }),
    [users.data, teams.data, tags.data, stages.data, events.data, orgs.data, users.isLoading, teams.isLoading, tags.isLoading, stages.isLoading, events.isLoading, orgs.isLoading],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useEntityOptions(): EntityOptions {
  return useContext(Ctx);
}

export type EntityKind = "user" | "team" | "tag" | "stage" | "event" | "organization" | "contact";

/**
 * Which tenant record a config/condition key refers to. Keys are the same on
 * every trigger, condition and action of the catalog, so this mapping is the
 * one place that decides "show a selector instead of an id input".
 */
export function entityKindForKey(key: string): EntityKind | null {
  switch (key) {
    case "assignedToId":
    case "userId":
    case "createdById":
      return "user";
    case "teamId":
      return "team";
    case "tagId":
      return "tag";
    case "stage":
    case "fromStageKey":
    case "toStageKey":
      return "stage";
    case "eventId":
      return "event";
    case "organizationId":
      return "organization";
    case "contactId":
      return "contact";
    default:
      return null;
  }
}

export function optionsForKind(opts: EntityOptions, kind: EntityKind): Option[] {
  switch (kind) {
    case "user":
      return opts.users;
    case "team":
      return opts.teams;
    case "tag":
      return opts.tags;
    case "stage":
      return opts.stages;
    case "event":
      return opts.events;
    case "organization":
      return opts.organizations;
    default:
      return [];
  }
}

export const ENTITY_KIND_LABEL: Record<EntityKind, string> = {
  user: "user",
  team: "team",
  tag: "tag",
  stage: "pipeline stage",
  event: "event",
  organization: "organization",
  contact: "contact",
};
