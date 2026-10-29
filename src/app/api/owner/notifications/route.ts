/**
 * GET /api/owner/notifications[?businessId=] → { items: OwnerNotification[] } newest first, max 200.
 * Rows hold masked recipients only (never addresses, numbers or message bodies).
 */
import {
  NotificationAudience,
  NotificationChannel,
  NotificationStatus,
  type OwnerNotificationsResponse,
} from "@/contracts";
import { getBusiness } from "@/config/businesses";
import { listNotifications } from "@/domain";
import { ownerGet } from "../../_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = ownerGet(
  "notifications",
  async ({ businessId }): Promise<OwnerNotificationsResponse> => {
    const rows = await listNotifications(200, businessId);
    const items: OwnerNotificationsResponse["items"] = [];
    for (const n of rows) {
      // Columns are strings (portable schema); skip anything outside the documented values.
      const channel = NotificationChannel.safeParse(n.channel);
      const audience = NotificationAudience.safeParse(n.audience);
      const status = NotificationStatus.safeParse(n.status);
      if (!channel.success || !audience.success || !status.success) continue;
      items.push({
        id: n.id,
        businessId: n.businessId,
        businessName: getBusiness(n.businessId)?.name ?? n.businessId,
        createdAt: n.createdAt.toISOString(),
        channel: channel.data,
        audience: audience.data,
        provider: n.provider,
        status: status.data,
        toMasked: n.toMasked,
        subject: n.subject,
        relatedRef: n.relatedRef,
        error: n.error,
      });
    }
    return { items };
  },
);
