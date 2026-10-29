/**
 * Request IDs (SPEC §8, AT-85). The proxy assigns one to every request: a safe incoming
 * `x-request-id` (8–128 chars of `[A-Za-z0-9._:-]`) is kept, anything else is replaced by a
 * random UUID. Route handlers read it with `getRequestId(request.headers)`.
 */
export const REQUEST_ID_HEADER = "x-request-id";

const SAFE_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export function acceptRequestId(incoming: string | null | undefined): string {
  if (incoming && SAFE_ID.test(incoming)) return incoming;
  return crypto.randomUUID();
}

/** The request id the proxy attached (or a fresh one if the proxy did not run). */
export function getRequestId(headers: Headers): string {
  return acceptRequestId(headers.get(REQUEST_ID_HEADER));
}
