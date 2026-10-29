/** Business lookups from src/config/businesses.ts (profiles, hours, policies, service area). */
import { BUSINESSES, getBusiness, type BusinessProfile } from "@/config/businesses";

export class DomainError extends Error {
  constructor(
    public readonly code: "unknown_business" | "unknown_conversation" | "wrong_business_kind",
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

/** Throws DomainError for an unknown id (callers inject ids from server-side records). */
export function requireBusiness(businessId: string): BusinessProfile {
  const b = getBusiness(businessId);
  if (!b) throw new DomainError("unknown_business", `Unknown business ${businessId}`);
  return b;
}

export { BUSINESSES };
