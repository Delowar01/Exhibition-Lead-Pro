import { useEffect } from "react";

import { getListEventsQueryKey, useListEvents } from "@workspace/api-client-react";

import { useAuth } from "@/contexts/AuthContext";
import { useSettings } from "@/contexts/SettingsContext";

const EVENTS_PARAMS = { limit: 100 };

/**
 * Renders nothing. While signed in with an active event (or an event filter)
 * set, it loads the tenant's event list — the same query the event picker uses
 * — and drops any selected event the tenant no longer has, so no capture path
 * can submit a deleted or foreign eventId.
 */
export function ActiveEventGuard() {
  const { isAuthenticated } = useAuth();
  const { activeEventId, contactFilters, reconcileEvents } = useSettings();
  const needsCheck = isAuthenticated && (activeEventId !== null || contactFilters.eventId !== null);

  const query = useListEvents(EVENTS_PARAMS, {
    query: { enabled: needsCheck, queryKey: getListEventsQueryKey(EVENTS_PARAMS) },
  });

  useEffect(() => {
    if (needsCheck && query.isSuccess && query.data) {
      reconcileEvents(query.data.events, query.data.total);
    }
  }, [needsCheck, query.isSuccess, query.data, reconcileEvents]);

  return null;
}
