import { z } from "zod";
import { Email, Reference } from "./common";
import { LookupStatusOutput } from "./tools";

/** /status page + lookup_status tool. Wrong pair → same generic "not found". */
export const StatusLookup = z.object({
  reference: Reference,
  email: Email,
});
export type StatusLookup = z.infer<typeof StatusLookup>;

/**
 * POST /api/status → 200 StatusResponse (found or the generic not-found; the business is
 * resolved server-side from the reference, so the body carries no businessId).
 * 400/429/500 → ApiErrorBody.
 */
export const StatusResponse = LookupStatusOutput;
export type StatusResponse = z.infer<typeof StatusResponse>;

/** Error envelope used by /api/status, /api/chat and the checkout GET endpoints. */
export const ApiErrorBody = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;

export const OwnerLogin = z.object({
  username: z.string().trim().min(1, "Username is required").max(100),
  password: z.string().min(1, "Password is required").max(200),
});
export type OwnerLogin = z.infer<typeof OwnerLogin>;
