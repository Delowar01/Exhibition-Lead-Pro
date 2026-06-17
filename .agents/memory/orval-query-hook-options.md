---
name: Orval query hook options require queryKey
description: Passing query options (enabled, etc.) to a generated useGetX hook also requires an explicit queryKey
---

# Orval-generated query hooks: queryKey is required when passing options

In this repo's `@workspace/api-client-react` generated hooks, the `options.query`
slot is typed as a full `UseQueryOptions` where `queryKey` is required. If you pass
ANY query option (e.g. `{ enabled }`) you must ALSO pass an explicit `queryKey`,
or typecheck fails.

**How to apply:** import the matching `getXxxQueryKey(params)` helper and pass it:

```ts
useListUsers({ limit: 100 }, {
  query: { enabled: someCondition, queryKey: getListUsersQueryKey({ limit: 100 }) },
});
```

**Why:** Omitting `queryKey` while supplying other options is a TS error, not a
runtime default — easy to miss because a bare `useListUsers({limit:100})` call
needs no queryKey at all.
