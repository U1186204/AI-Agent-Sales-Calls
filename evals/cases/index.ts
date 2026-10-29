import type { EvalCase } from "../types";
import { checkoutStatusCases } from "./checkout-status";
import { hardeningCases } from "./hardening";
import { flowCases } from "./flow";
import { guidedCases } from "./guided";
import { happyPathCases } from "./happy-path";
import { opsCases } from "./ops";
import { securityCases } from "./security";

export const ALL_CASES: EvalCase[] = [
  ...happyPathCases,
  ...flowCases,
  ...checkoutStatusCases,
  ...securityCases,
  ...opsCases,
  ...hardeningCases,
  ...guidedCases,
];

const ids = new Set<string>();
for (const c of ALL_CASES) {
  if (ids.has(c.id)) throw new Error(`Duplicate eval case id ${c.id}`);
  ids.add(c.id);
}
