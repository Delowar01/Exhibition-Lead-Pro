import { db } from "@workspace/db";
import { deviceTokensTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import { logger } from "./logger.js";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

interface ExpoMessage extends PushPayload {
  to: string;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

interface ExpoTicket {
  status: string;
  message?: string;
  details?: { error?: string };
}

// Sends a batch of messages through Expo's push service. The Expo endpoint is
// public and requires no credentials; an optional EXPO_ACCESS_TOKEN adds the
// "enhanced security" bearer when configured. Tokens Expo reports as
// DeviceNotRegistered are pruned so we stop pushing to dead devices.
async function sendExpoMessages(messages: ExpoMessage[]): Promise<boolean> {
  if (messages.length === 0) return false;
  const accessToken = process.env.EXPO_ACCESS_TOKEN;

  let allOk = true;
  for (const batch of chunk(messages, 100)) {
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify(
          batch.map((m) => ({
            to: m.to,
            title: m.title,
            body: m.body,
            data: m.data ?? {},
            sound: "default",
            priority: "high",
          })),
        ),
      });

      if (!res.ok) {
        const text = await res.text();
        logger.error({ status: res.status, text }, "Expo push send failed");
        allOk = false;
        continue;
      }

      const json = (await res.json()) as { data?: ExpoTicket[] };
      const tickets = json.data ?? [];
      const toPrune: string[] = [];
      tickets.forEach((ticket, i) => {
        if (ticket.status === "error" && ticket.details?.error === "DeviceNotRegistered") {
          toPrune.push(batch[i].to);
        }
      });
      if (toPrune.length > 0) {
        await db.delete(deviceTokensTable).where(inArray(deviceTokensTable.token, toPrune));
        logger.info({ count: toPrune.length }, "Pruned unregistered Expo push tokens");
      }
    } catch (err) {
      logger.error({ err }, "Expo push request error");
      allOk = false;
    }
  }
  return allOk;
}

// Looks up all device tokens for the given users and pushes the payload to each.
// Best-effort: never throws, so callers can fire-and-forget. Returns true only
// when at least one device token was found AND the send was dispatched without
// error, so callers can avoid marking work "notified" when nothing went out.
export async function notifyUsers(userIds: (number | null | undefined)[], payload: PushPayload): Promise<boolean> {
  const ids = [...new Set(userIds.filter((id): id is number => typeof id === "number"))];
  if (ids.length === 0) return false;
  try {
    const tokens = await db
      .select({ token: deviceTokensTable.token })
      .from(deviceTokensTable)
      .where(inArray(deviceTokensTable.userId, ids));
    if (tokens.length === 0) return false;
    return await sendExpoMessages(tokens.map((t) => ({ to: t.token, ...payload })));
  } catch (err) {
    logger.error({ err }, "notifyUsers failed");
    return false;
  }
}

export async function notifyUser(userId: number | null | undefined, payload: PushPayload): Promise<boolean> {
  return await notifyUsers([userId], payload);
}
