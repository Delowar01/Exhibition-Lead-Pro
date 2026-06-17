---
name: Auth token wiring
description: How to attach JWT tokens to API client requests in this workspace
---

Use `setAuthTokenGetter` exported from `@workspace/api-client-react` (not `setCustomFetch` — that does not exist).

Call it once at app startup (e.g. top of App.tsx):

```ts
import { setAuthTokenGetter } from "@workspace/api-client-react";
setAuthTokenGetter(() => localStorage.getItem("csp_token"));
```

**Why:** The custom fetch wrapper in `lib/api-client-react/src/custom-fetch.ts` checks `_authTokenGetter` before every request and attaches `Authorization: Bearer <token>`. This avoids per-call header boilerplate.

**How to apply:** Call once before `QueryClientProvider` renders. For Expo/RN, `setBaseUrl` is also available to point at a remote host.
