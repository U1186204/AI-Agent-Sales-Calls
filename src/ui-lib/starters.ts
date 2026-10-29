/**
 * Suggested first messages per business (UI constants; src/config/businesses.ts has no
 * starters field). Each chip sends its text as a real chat message.
 *
 * Every business has at least one chip that leads straight into a checkout or booking
 * ("order" / "book" / "appointment"), which both the real model and the scripted test
 * assistant (OASIS_LLM_STUB=1) turn into a secure form. The other chips are questions the
 * model answers from live data; the test assistant answers them from the policy list and
 * tells the customer how to start a checkout, so no chip is a dead end (EDGE-7).
 * Talking to a person is a dedicated control ("Talk to a person"), not a chip.
 */
export const STARTERS: Record<string, readonly string[]> = {
  "volt-supply": [
    "Do you have 12/2 Romex in stock?",
    "What does shipping to Phoenix, AZ 85004 cost?",
    "I'd like to order ten 20-amp single-pole breakers",
    "What's your return policy?",
  ],
  "flowline-plumbing": [
    "Do you carry 1/2 inch PEX in 100 ft rolls?",
    "I'd like to order a 50-gallon gas water heater",
    "How much is shipping to Anchorage, AK 99501?",
    "Can I return a toilet I didn't install?",
  ],
  "mountpro-tv": [
    "How much to mount a 65 inch TV?",
    "Why does mounting above a fireplace cost more?",
    "What's your next available appointment?",
    "Can you hide the cables in the wall?",
  ],
  "greenstripe-lawn": [
    "How much is a mow for a quarter-acre lawn?",
    "Do you offer weekly service?",
    "Can I book a mow this Saturday?",
    "What happens if it rains?",
  ],
  "brightnest-cleaning": [
    "What's the price for a 3-bedroom standard clean?",
    "What's included in a deep clean?",
    "Can I book a move-out clean for next week?",
    "Do I need to be home during the clean?",
  ],
};
