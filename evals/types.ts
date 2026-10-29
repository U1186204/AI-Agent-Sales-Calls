/** Eval case contract (no runtime imports: cases load before the app modules are configured). */
import type { BusinessSlug } from "../src/contracts/common";
import type { Harness } from "./harness";

export type Category =
  | "happy_path"
  | "mid_flow_question"
  | "stock"
  | "availability"
  | "form_validation"
  | "pii"
  | "corrections"
  | "status_lookup"
  | "injection"
  | "off_topic"
  | "shipping"
  | "escalation"
  | "resilience"
  | "quote"
  | "isolation"
  | "guided";

export interface EvalCase {
  id: string;
  category: Category;
  business: BusinessSlug;
  title: string;
  /** Status lookups legitimately ask for the order email in chat. */
  allowEmailInChat?: boolean;
  /** Fallback replies are expected (fault / budget cases). */
  expectFallback?: boolean;
  run(h: Harness): Promise<void>;
}

export type AssertionKind = "tool" | "state" | "text" | "judge";

export interface AssertionResult {
  kind: AssertionKind;
  name: string;
  pass: boolean;
  detail?: string;
}
