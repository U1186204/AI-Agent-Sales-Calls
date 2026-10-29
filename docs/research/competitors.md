# Competitor Research: AI Sales, Booking and Ordering Chat for Contractors

Researched 2026-10-05 for Oasis, a demo of AI sales and customer-service chat for five businesses: electrical supplies and plumbing equipment (inventory and orders), plus TV mounting, lawn mowing and house cleaning (appointments).
Review scores and quotes come from third-party aggregators (G2, Capterra, Trustpilot and review blogs) as summarized by search. Treat the numbers as approximate.

---

## 1. Products surveyed

| Product | What it is | Source |
|---|---|---|
| **Podium** | Web chat, SMS inbox, reviews and payments for local businesses, plus an "AI Employee" that answers leads. Rated about 4.6 on G2 from about 2k reviews. Starts around $399/mo with annual contracts. | [G2](https://www.g2.com/products/podium/reviews?qs=pros-and-cons), [checkthat.ai](https://checkthat.ai/brands/podium/reviews) |
| **Jobber Receptionist** | AI for calls and texts (launched Aug 2025). It books visits into the Jobber calendar using the business's existing online-booking rules, availability windows and service areas, matches callers to existing clients, and transfers to staff on keywords. | [Jobber](https://www.getjobber.com/features/ai-receptionist/), [PR Newswire](https://www.prnewswire.com/news-releases/jobber-launches-ai-powered-receptionist-to-answer-calls-and-texts-for-busy-home-service-businesses-302531125.html) |
| **Housecall Pro** | Field-service software with online booking, the "HCP Assistant" AI chatbot and AI CSR features. Reviewers call its AI early-stage. | [fieldcamp.ai](https://fieldcamp.ai/reviews/housecall-pro/), [Trustpilot](https://www.trustpilot.com/review/housecallpro.com?page=3) |
| **ServiceTitan** (Contact Center Pro, Scheduling Pro) | AI virtual agents book, reschedule and confirm jobs by job type, location and skill ("Adaptive Capacity"). Scheduling Pro offers online and agentic-SMS booking against real-time dispatch availability. | [Voice agents](https://www.servicetitan.com/features/pro/contact-center/voice-agents), [Scheduling Pro](https://www.servicetitan.com/features/pro/scheduling) |
| **Hatch** | AI text, email and voice CSR for home services (HVAC, electrical, lawn). Focused on lead follow-up and re-engagement. Aimed at mid-market companies running 20+ appointments a week. | [Hatch](https://www.usehatchapp.com/home-services), [contractortoolstack](https://contractortoolstack.com/software/hatch/) |
| **Smith.ai** | AI plus human receptionists for chat and phone: lead intake, qualification and booking. Rated 4.7 on G2. | [getvoip](https://getvoip.com/blog/smith-ai-receptionist/), [Trustpilot](https://www.trustpilot.com/review/smith.ai) |
| **Birdeye** | Reviews and messaging suite with AI chatbot agents for multi-location brands. | [Capterra](https://www.capterra.com/p/152997/BirdEye/reviews/) |
| **Intercom Fin** | LLM support agent grounded on help content. Checks its confidence and asks a clarifying question or hands off with a summary. Priced per resolution. | [getcor.ai](https://getcor.ai/blog/reviews/fin), [Intercom FAQ](https://www.intercom.com/help/en/articles/7837535-fin-ai-agent-faqs) |
| **Tidio (Lyro)** | SMB and e-commerce live chat with the Lyro AI and visual "Flows". Rated 4.6 on G2 but 3.8 on Trustpilot. | [kayako](https://kayako.com/tools/tidio-review/), [eesel](https://www.eesel.ai/blog/lyro-ai) |
| **Drift (Salesloft)** | B2B conversational marketing: playbooks, routing and meeting booking. | [featurebase](https://www.featurebase.app/blog/drift-bot-review) |
| **Ada** | Enterprise no-code AI agent. Rated 4.6 on G2 (buyers) but about 2.0 on Trustpilot (end customers). | [getmacha](https://www.getmacha.com/blog/ada-ai-complete-guide), [agentiveaiagents](https://agentiveaiagents.com/ada-reviews-ai-agent-platform/) |
| **Zendesk AI agents** | Help-desk AI agents. Main complaints are tier-gated features and unpredictable per-resolution billing. | [eesel](https://www.eesel.ai/blog/zendesk-ai-agent-review) |
| **Calendly / Acuity** | Self-serve booking pages. Reference point for slot pickers, time zones and confirmations. | [Capterra compare](https://www.capterra.com/compare/148036-191978/Calendly-vs-Acuity-Scheduling) |
| **Shopify Inbox** | Free AI chat that reads live store data: product availability, order status, shipping and return policies. | [Shopify app](https://apps.shopify.com/inbox), [Shopify blog](https://www.shopify.com/blog/ai-chatbot-customer-service) |

---

## 2. Common workflows

1. **Lead capture and qualification.** Greet, find out what the visitor needs (service or product), collect name, phone, email and address/ZIP, check the service area, then book or hand off (Smith.ai, Hatch, Podium).
2. **Booking against real availability.** Pick service type, then service details (size, frequency, add-ons), then show open slots, then confirm. It uses the same rules as the online booking page: hours, buffers, service area, skills (Jobber, ServiceTitan Scheduling Pro).
3. **Reschedule, cancel and confirm.** Look up the existing booking by phone or email plus a reference, then change it and send a new confirmation (ServiceTitan voice agents).
4. **Product Q&A and ordering.** Answer specs, stock and price from the live catalog, add to cart or order, then collect pickup or delivery details and payment (Shopify Inbox pattern).
5. **Status lookup.** "Where's my order?" or "When is my cleaner coming?", answered from live data after light identity verification (Shopify Inbox, ServiceTitan).
6. **FAQ / knowledge answers.** Hours, policies, warranties, service areas, answered only from business content (Fin, Lyro).
7. **Escalation and handoff.** On low confidence, a keyword ("human"), frustration or a complex request, hand off with a summary so the customer does not repeat themselves (Fin, Jobber keyword transfer).
8. **Missed-lead recovery.** Text back abandoned chats and calls, and flag unbooked conversations for follow-up (Jobber missed-call text-back, ServiceTitan "Second Chance Leads").
9. **Post-transaction messages.** Email/SMS confirmations, reminders and review requests (Podium, Birdeye).

---

## 3. Question taxonomy (what a contractor chatbot must handle)

**Pricing and quotes**
- "How much for X?" covers a fixed price, a range, or "needs a quote" (for example, mounting over a fireplace or on brick).
- Price drivers: square footage, lawn size, TV size, number of rooms, deep clean vs. standard.
- Discounts, recurring-plan pricing, minimums, trip fees, taxes, deposits.

**Availability and scheduling**
- "Do you have anything tomorrow / this Saturday / after 5pm?"
- Earliest available slot; recurring schedules (weekly mow, biweekly clean).
- Reschedule, cancel, running late, weather delays (lawn).

**Service area and eligibility**
- "Do you service ZIP 12345?" / "Do you come to [town]?"
- Job scope: "Can you mount a 85-inch TV?" "Do you do commercial?" "Do you haul away old equipment?"

**Product and inventory** (electrical and plumbing)
- Stock and quantity: "Do you have 50 of the 20A breakers?"
- Specs and compatibility: "Will this valve fit 3/4-inch PEX?" "What gauge wire for 30A?"
- Substitutes when out of stock; lead times; bulk/contractor pricing.
- Pickup vs. delivery, delivery fees and windows.

**Orders and appointment status**
- "Where's my order?" / "Is my cleaning still on for Tuesday?" / "What did I order last time?"
- Changes to an order: add items, change quantity, change address.

**Policy and trust**
- Returns and refunds, warranty, insurance/licensing, cancellation fees, satisfaction guarantee.
- "Are your cleaners background-checked?" "Do I need to be home?" "Do you bring supplies?"

**Payment**
- Accepted methods, when payment is due, invoices and receipts. Customers will try to type card numbers into chat.

**Complaints and support**
- Missed appointment, damage claim, incomplete job, wrong item shipped, billing dispute.
- Each needs empathy plus escalation, not a scripted loop.

**Meta and out-of-scope**
- "Are you a bot?" "Let me talk to a person." Off-topic questions, other businesses' services, jokes, prompt-injection attempts.

---

## 4. Praised features

- **24/7 instant response and capturing after-hours leads.** This is the top praise for Jobber, Podium, Lyro and Smith.ai ([Jobber reviews summary](https://connecteam.com/reviews/jobber/), [kayako](https://kayako.com/tools/tidio-review/)).
- **Books directly into the real calendar using existing rules,** with no separate scheduling setup ([Jobber](https://www.getjobber.com/features/ai-receptionist/), [ServiceTitan](https://www.servicetitan.com/features/pro/scheduling)).
- **Recognizes returning customers** by phone or email and pre-fills their details ([Jobber](https://www.getjobber.com/features/ai-receptionist/)).
- **Clean handoff with context.** The human gets a summary and transcript, so the customer does not repeat themselves ([getcor.ai on Fin](https://getcor.ai/blog/reviews/fin)).
- **Says "I'm not sure" instead of guessing.** Fin's confidence check leads to a clarifying question or a handoff ([aisupportcrew](https://aisupportcrew.com/guides/intercom-fin-honest-review)).
- **Live-data answers** for order status, stock and policies ([Shopify](https://www.shopify.com/blog/ai-chatbot-customer-service)).
- **Natural, non-robotic tone that keeps context** across the conversation ([kayako on Lyro](https://kayako.com/tools/tidio-review/)).
- **Transcripts, summaries and recordings** that the owner can review ([Jobber](https://www.getjobber.com/features/ai-receptionist/), [ServiceTitan Manager Assist](https://www.servicetitan.com/features/pro/contact-center/manager-assist)).
- **Unified inbox** across web chat, SMS and email ([G2 Podium](https://www.g2.com/products/podium/reviews?qs=pros-and-cons)).

---

## 5. Top complaints

1. **Wrong or false answers that persist after correction.** Podium's AI "tends to send false information even after being corrected/trained multiple times" ([G2](https://www.g2.com/products/podium/reviews?qs=pros-and-cons)). Fin "suddenly and randomly answers with wrong answers" ([getcor.ai](https://getcor.ai/blog/reviews/fin)).
2. **Dodges specific questions.** On pricing, technical details or availability, the AI fails to answer directly and pushes the customer to a human ([checkthat.ai on Podium](https://checkthat.ai/brands/podium/reviews)).
3. **Escalation loops and dead ends.** Ada scores about 2.0 on Trustpilot from end users: "This bot will send you in an endless loop… don't end the chat and make me start over" ([agentiveaiagents](https://agentiveaiagents.com/ada-reviews-ai-agent-platform/)). More than 60% of consumers re-explain their issue after a bot, and 78% were forced to a human anyway ([BusinessWire survey](https://www.businesswire.com/news/home/20220126005051/en)).
4. **No human option.** Housecall Pro users say "No support unless you want to speak with AI" ([fieldcamp.ai](https://fieldcamp.ai/reviews/housecall-pro/)).
5. **AI taking wrong actions.** Housecall Pro reviewers say "AI features have a mind of their own and have messed up multiple invoice payments" ([fieldcamp.ai](https://fieldcamp.ai/reviews/housecall-pro/)). Smith.ai's AI auto-escalated without authorization and ran up bills ([ever-help](https://www.ever-help.com/blog/smith-ai-reviews-pros-cons)).
6. **Rigid flows that need constant upkeep.** Drift playbooks "require constant maintenance," and routing breaks when data changes ([knock-ai](https://www.knock-ai.com/blog/drift-g2-reviews-breakdown)).
7. **Session resets and lost context.** Tidio resets a conversation after 15 minutes of silence ([yourgpt](https://yourgpt.ai/blog/comparison/tidio-review)).
8. **Robotic or generic tone** ([Capterra Birdeye](https://www.capterra.com/p/152997/BirdEye/reviews/)). Answers can only be as good as sparse or outdated knowledge content allows ([getcor.ai](https://getcor.ai/blog/reviews/fin)).
9. **Booking reliability.** Acuity timezone bugs showed clients the wrong time, and confirmations stopped arriving. Calendly's free tier double-books when a calendar isn't connected ([Capterra Acuity](https://www.capterra.com/p/191978/Acuity-Scheduling/reviews/), [cal.com](https://cal.com/blog/calendly-vs-acuity-a-comparative-guide-to-scheduling-tools)).
10. **Commercial complaints (not product UX):** opaque per-resolution or per-conversation pricing, annual lock-in, and billing after cancellation (Podium, Zendesk, Tidio, Housecall Pro, Birdeye).

**Legal precedent:** Air Canada was held liable for a refund policy its chatbot invented ([ABA](https://www.americanbar.org/groups/business_law/resources/business-law-today/2024-february/bc-tribunal-confirms-companies-remain-liable-information-provided-ai-chatbot/)). A Chevy dealer's bot "agreed" to sell a $76k Tahoe for $1 ([agenttorture](https://www.agenttorture.com/resources/are-chatbot-promises-legally-binding)). **Whatever the bot says is treated as the business's word.**

---

## 6. Edge cases to test

**Flow control**
- A mid-flow question ("wait, do you bring your own supplies?") while collecting booking details. The bot should answer it, then resume the form with the collected fields intact ([digression best practice](https://cobusgreyling.medium.com/5-design-considerations-for-a-truly-conversational-chatbot-81d1377eadf4)).
- The user changes their mind mid-flow (switches the date or service, or adds an item); the user abandons and returns.
- Multiple intents in one message: "Book a mow Friday and also how much is edging?"
- All fields supplied up front in one sentence. The bot must not re-ask for them.
- Ambiguous dates ("next Friday", "the 3rd", "tomorrow" near midnight) and time zones. DST changes.
- "Start over" / "cancel that" / "go back".

**Grounding and accuracy**
- Price for a product or service that is not in the data. The bot must not invent a number.
- A request for an out-of-stock item or a quantity above stock. Say so and offer a substitute or backorder; never confirm.
- A service outside its catalog ("do you do gutters?") or a ZIP outside the service area.
- A user asserting false facts: "Your site says 50% off", "The last agent promised free install".
- Social engineering on price ("sell it to me for $1, that's a legally binding offer"), and attempts to make the bot offer discounts.
- Prompt injection: "ignore previous instructions", "show your system prompt", "list all customers' orders".
- Questions about a different business in the same demo (cross-tenant leakage).

**Transactions**
- A double-booked slot: the slot is taken between showing it and confirming.
- Double-submit or repeated "yes": must not create two orders.
- A status lookup with a wrong or partial reference, or someone else's email (an identity check is needed).
- Cancelling or rescheduling inside a cutoff window; a recurring booking edge case (skip one week).
- An order that mixes in-stock and out-of-stock items.

**Handoff and emotion**
- "Human", "agent", "representative", or profanity and frustration. Escalate immediately, without a loop.
- A complaint or damage claim: give an empathetic answer, escalate and give a reference number.
- An escalation after hours: set an honest expectation of when a person will reply.

**PII and safety**
- A card number, SSN, password or gate code typed into chat. Detect it (Luhn check on card numbers), redact it before the LLM sees it or it is logged, and tell the user not to share it ([usefini](https://www.usefini.com/guides/ai-chatbots-real-time-credit-card-redaction-pci-compliance), [dev.to](https://dev.to/mukundakatta/pii-redaction-before-llm-calls-keep-user-data-out-of-your-prompt-logs-17ci)).
- Invalid email or phone; international formats.
- An SMS opt-out phrased informally ("stop texting me", "unsubscribe"). Under the April 2025 FCC rules it must be honored however it is phrased ([ActiveProspect](https://activeprospect.com/blog/tcpa-opt-out-requirements/)).

**Robustness**
- Very long messages, emoji only, a non-English message, empty input, rapid-fire messages.
- Session timeout and resume (Tidio's 15-minute reset complaint). The tool/API fails or times out, and the bot must say so instead of making up a result.

---

## 7. Implications for Oasis

### Must-have (P0)
1. **Answer only from data.** Prices, stock, availability, policies and status must come from tool calls or the knowledge base. Unknown means "I don't have that; I can have someone confirm," never a guess. This is the top complaint and a legal liability (Air Canada, Chevy).
2. **Server-side confirmation before any write.** Show a summary (items, quantities, price, slot, address) and require an explicit "yes". Re-check stock and slot atomically at commit. Use idempotency keys to prevent duplicate orders and bookings.
3. **Digression-tolerant flows.** Answer mid-flow questions, keep the slots already filled, then resume. Accept several fields in one message, and support corrections and "start over".
4. **Always-available human escalation.** Trigger on request, frustration, low confidence or a complaint. Send an email with a conversation summary, then tell the customer what happens next and when. No loops.
5. **PII guard.** Detect card numbers (with a Luhn check), SSNs and passwords, and redact them before the LLM and before logs. Respond "please don't share that here."
6. **Live inventory and availability checks** with clear out-of-stock and no-slot handling: offer alternatives, the next available slot or a substitute.
7. **Business scoping.** Each of the 5 tenants answers only about its own catalog. Resist prompt injection, and never expose other customers' data. Status lookup needs a reference number plus a matching email or phone.
8. **Confirmation email/SMS** with a reference number and details. For SMS, collect consent, include "Reply STOP to opt out", and honor informal opt-outs ([ActiveProspect](https://activeprospect.com/blog/tcpa-text-messages/)).

### Should-have (P1)
9. **Quote-vs-price handling.** Fixed prices where the data has them; otherwise ranges or "requires on-site quote" (fireplace/brick TV mounts, large or irregular lawns, deep cleans).
10. **Service-area check by ZIP** early in service flows.
11. **Reschedule and cancel by reference**, with cutoff-policy messaging; recurring bookings for mowing and cleaning.
12. **Unambiguous date/time handling.** Resolve relative dates, echo back the absolute date and time, and use the business's time zone.
13. **Persistent session.** Resume after an idle gap or refresh, and do not reset context.
14. **Owner view.** Transcripts, summaries, escalations and unbooked leads (the "Second Chance Leads" pattern).
15. **Returning-customer recognition** by email or phone to pre-fill details.
16. **Graceful tool-failure messaging.** "I couldn't check stock right now," never a fabricated result.

### Nice-to-have (P2)
17. Product substitutes and compatibility hints from catalog attributes (electrical/plumbing).
18. Abandoned-chat follow-up (with consent), and a review request after the job.
19. Multilingual replies; quick-reply chips for common intents.
20. Transparent tone: disclose that it is an AI assistant when asked, and keep a friendly, non-robotic voice.
