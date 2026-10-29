/**
 * Domain public API (SPEC §4). Other modules import ONLY from here.
 * Rules: every business-scoped function takes `businessId` first and filters by it; user
 * errors come back as structured results (never thrown); no LLM calls; no process.env reads.
 * Only `confirmCheckout(...).notification` and `recordEscalation(...).notification` carry
 * decrypted PII/summary out of the domain — hand them to notify, never log them.
 */
import "server-only";

export {
  listBusinesses,
  getBusinessProfile,
  searchCatalog,
  getProduct,
  listServices,
  quoteService,
  getPolicies,
  checkServiceArea,
} from "./catalog";
export { checkInventory, quoteProducts } from "./inventory";
export { checkAvailability } from "./availability";
export {
  createCheckoutDraft,
  getCheckoutDraft,
  getCheckoutDraftForConversation,
  listDraftSlots,
  updateDraftServiceConfig,
} from "./checkout-draft";
export { buildServiceOptions, serviceOptionsForBusiness } from "./service-options";
export { reviewCheckout, confirmCheckout } from "./checkout";
export { lookupStatus } from "./status";
export { recordEscalation, hasRecentOpenEscalation, ESCALATION_DEDUPE_MS } from "./escalation";
export { itemsLabel } from "./status";
export { maxBookableMinutes, requiresOnSiteEstimate, isBookingDay, earliestStart } from "./hours";
export {
  createConversation,
  getConversation,
  appendMessage,
  addUsage,
  getDailyUsage,
  setConversationOutcome,
} from "./conversations";
export {
  ownerOverview,
  listOrders,
  listBookings,
  inventoryLevels,
  availabilitySummary,
  listNotifications,
  listConversations,
  ownerToday,
  contractorAvailability,
  listEscalations,
  getConversationTranscript,
  timezoneLabelAt,
} from "./owner";

export { DomainError } from "./business";

export type {
  BusinessListing,
  PublicBusinessProfile,
  SearchCatalogResult,
  ServiceQuoteResult,
} from "./catalog";
export type { InventoryLine, ProductQuoteResult, LineRequest } from "./inventory";
export type { AvailabilityQuery, AvailabilityResult } from "./availability";
export type {
  CreateDraftInput,
  CreateDraftResult,
  DraftView,
  DraftSlotsResult,
  UpdateDraftResult,
} from "./checkout-draft";
export type {
  CheckoutRequest,
  CheckoutFailure,
  ReviewResult,
  ConfirmResult,
  ConfirmDeps,
  CheckoutNotification,
} from "./checkout";
export type { StatusResult } from "./status";
export type { EscalationResult, EscalationReasonCode } from "./escalation";
export type {
  ConversationRecord,
  ConversationOutcome,
  MessageRole,
  StoredMessage,
  UsageTotals,
} from "./conversations";
export type {
  OwnerOverview,
  OwnerOrderRow,
  OwnerBookingRow,
  InventoryRow,
  AvailabilityDay,
  OwnerConversationRow,
  ListFilter,
  MaskedContact,
  OwnerTodayStats,
  ContractorAvailabilityRow,
  OwnerEscalationRow,
  OwnerTranscriptView,
} from "./owner";
