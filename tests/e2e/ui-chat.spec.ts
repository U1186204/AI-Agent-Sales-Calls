import { expect, test, type Page } from "@playwright/test";
import {
  CONVERSATION,
  REPLY_HUMAN,
  REPLY_PRODUCT_FORM,
  REPLY_SERVICE_FORM,
  REPLY_STOCK,
  chatText,
} from "./support/fixtures";
import {
  expectNoHorizontalScroll,
  expectNoSeriousA11yViolations,
  expectTapTargets,
  mockChat,
  mockCheckout,
} from "./support/mocks";

const isWide = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;
const isPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 600;

/** The transparency panel: side panel on wide screens, a dialog sheet otherwise. */
async function openTrace(page: Page) {
  if (isWide(page)) return page.locator("aside.trace-aside");
  await page.locator(".trace-toggle").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

const FALLBACK_TEXT =
  "Sorry — I'm having trouble responding right now. Please try again in a moment, or use the **Talk to a person** button to reach the team.";

test.describe("chat (AT-60, AT-83, AT-90..92)", () => {
  test("welcome, starters, a reply with trace, and conversation persistence", async ({ page }) => {
    const bodies = await mockChat(page, [REPLY_STOCK]);
    await page.goto("/chat/volt-supply");
    await expect(page).toHaveTitle(/Chat with Volt & Wire Electrical Supply/);
    await expect(page.locator(".msg--assistant .bubble").first()).toContainText(
      "Volt & Wire assistant",
    );

    // Empty trace state explains what will appear.
    let trace = await openTrace(page);
    await expect(trace.getByText("After the agent replies, you’ll see here:")).toBeVisible();
    if (!isWide(page)) await page.keyboard.press("Escape");

    await expectNoSeriousA11yViolations(page, "chat empty");
    await expectNoHorizontalScroll(page);

    const starter = page
      .getByRole("group", { name: "Suggested questions" })
      .getByRole("button")
      .first();
    const starterText = (await starter.textContent()) ?? "";
    await starter.click();

    await expect(page.locator(".msg--user .bubble")).toHaveText(starterText);
    const reply = page.locator(".msg--assistant .bubble").nth(1);
    await expect(reply.locator("strong")).toHaveText("Romex 12/2 NM-B w/G, 250 ft");
    await expect(reply.locator("li")).toHaveCount(2);
    expect(bodies[0]).toMatchObject({ businessId: "volt-supply", message: starterText });
    expect(bodies[0]).not.toHaveProperty("conversationId");
    // Starter chips disappear once the customer has spoken.
    await expect(page.getByRole("group", { name: "Suggested questions" })).toHaveCount(0);

    // Trace: labels, why, readable inputs, data refs, usage footer.
    await page.getByRole("button", { name: /2 lookups: see how it answered/ }).click();
    trace = isWide(page) ? page.locator("aside.trace-aside") : page.getByRole("dialog");
    await page.waitForTimeout(450); // let the sheet's 400 ms entrance finish before axe
    await expect(trace.getByText("Checked live inventory")).toBeVisible();
    await expect(
      trace.getByText("To confirm there is enough stock for two rolls before quoting."),
    ).toBeVisible();
    await expect(trace.locator(".trace-kv").first()).toContainText("12/2 romex");
    await expect(trace.locator(".chip", { hasText: "EL-NM122-250" }).first()).toBeVisible();
    await expect(trace.locator(".trace-usage")).toContainText("claude-haiku-4-5");
    await expect(trace.locator(".trace-usage")).toContainText("$0.0042");
    await expect(trace.locator("pre:visible")).toHaveCount(0); // raw JSON only inside a closed disclosure
    await expectNoSeriousA11yViolations(page, "chat with trace");
    if (!isWide(page)) {
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toBeHidden();
      // Focus returns to the control that opened the panel.
      await expect(
        page.getByRole("button", { name: /2 lookups: see how it answered/ }),
      ).toBeFocused();
    }

    // Second message reuses the conversation id (Enter sends; Shift+Enter is a newline).
    const input = page.getByRole("textbox", { name: "Message Volt & Wire" });
    await input.fill("line one");
    await input.press("Shift+Enter");
    await input.pressSequentially("line two");
    await expect(input).toHaveValue("line one\nline two");
    await input.press("Enter");
    await expect.poll(() => bodies.length).toBe(2);
    expect(bodies[1]).toMatchObject({
      conversationId: CONVERSATION,
      message: "line one\nline two",
    });

    // Reload keeps the conversation (sessionStorage).
    await page.reload();
    await expect(page.locator(".msg--user")).toHaveCount(2);

    // Start over clears it and the next message starts a new conversation.
    await page.getByRole("button", { name: "Start over" }).click();
    await expect(page.locator(".msg--user")).toHaveCount(0);
    await expect(input).toBeFocused();
    await input.fill("hello again");
    await input.press("Enter");
    await expect.poll(() => bodies.length).toBe(3);
    expect(bodies[2]).not.toHaveProperty("conversationId");
  });

  test("trace hides noise: no 0 ms, no empty values, no raw ids, chips capped (VIS-1)", async ({
    page,
  }) => {
    const refs = Array.from({ length: 6 }, (_, i) => ({ type: "sku" as const, id: `EL-X${i}` }));
    await mockChat(page, [
      chatText("Here are the matches.", [
        {
          id: "t1",
          kind: "tool",
          tool: "search_catalog",
          label: "Searched the catalog",
          why: "Find wire.",
          input: { query: "", limit: 25 },
          outputSummary: "25 matches.",
          dataRefs: [...refs, { type: "draft", id: "cmuvybvuv000q4coy10yfzzyr" }],
          moreRefs: 19,
          ok: true,
          ms: 0,
        },
        {
          id: "t2",
          kind: "model",
          label: "Wrote the reply",
          why: "oasis-test-stub · 2 calls",
          outputSummary: "Replied in text.",
          dataRefs: [],
          ok: true,
          ms: 0,
        },
      ]),
    ]);
    await page.goto("/chat/volt-supply");
    await page.locator("#chat-input").fill("wire");
    await page.locator("#chat-input").press("Enter");
    // R2-9: only tool calls count as lookups (the model step is not one).
    await page.getByRole("button", { name: /^1 lookup: see how it answered/ }).click();
    const trace = isWide(page) ? page.locator("aside.trace-aside") : page.getByRole("dialog");
    const step = trace.locator(".trace-step").first();
    await expect(step).toBeVisible();
    await expect(step.locator(".trace-step__ms")).toHaveCount(0);
    await expect(step.locator(".trace-kv dt")).toHaveText(["Limit"]); // empty "Query" hidden
    await expect(step.locator("li.chip")).toHaveCount(5);
    await expect(step.getByText("cmuvybvuv000q4coy10yfzzyr")).toHaveCount(0);
    const more = step.getByRole("button", { name: "+20 more" });
    await more.click();
    await expect(step.locator("li.chip", { hasText: "EL-X5" })).toBeVisible();
    await expect(step.getByText("+19 more")).toBeVisible();
    await expect(step.getByRole("button", { name: "Show fewer" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    // Model steps show only the usage line, not a "Why:" row (VIS-15).
    await expect(trace.locator(".trace-step[data-kind='model'] .trace-step__why")).toHaveCount(0);
  });

  test("user text and assistant text render as text, never HTML (AT-83)", async ({ page }) => {
    const payload = `<img src=x onerror="window.__xss=1"><script>window.__xss=1</script>`;
    await mockChat(page, [chatText(`You said: ${payload}`)]);
    await page.goto("/chat/flowline-plumbing");
    const input = page.getByRole("textbox", { name: "Message Flowline" });
    await input.fill(payload);
    await input.press("Enter");
    await expect(page.locator(".msg--user .bubble")).toHaveText(payload);
    await expect(page.locator(".msg--assistant .bubble").nth(1)).toContainText("<script>");
    await expect(page.locator(".messages img")).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as unknown as { __xss?: number }).__xss),
    ).toBeUndefined();
  });

  test("composer enforces the character limit; counter only near the limit", async ({ page }) => {
    await mockChat(page, [REPLY_STOCK]);
    await page.goto("/chat/greenstripe-lawn");
    const input = page.getByRole("textbox", { name: "Message GreenStripe" });
    await input.fill("hello");
    await expect(page.locator("#chat-count")).toHaveCount(0);
    await input.fill("x".repeat(2001));
    await expect(page.locator("#chat-count")).toContainText("2,001 / 2,000");
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  test("rate limit waits for Retry-After; Try again never duplicates the message (VIS-7, WF-6)", async ({
    page,
  }) => {
    const bodies = await mockChat(page, (_body, n) => {
      if (n === 0)
        return {
          status: 429,
          headers: { "Retry-After": "2" },
          body: { error: { code: "rate_limited", message: "Slow down" } },
        };
      if (n === 1) {
        return {
          body: {
            conversationId: CONVERSATION,
            blocks: [],
            trace: [],
            fallback: true,
            offerEscalation: true,
            error: { code: "budget_exceeded", message: "Budget reached" },
          },
        };
      }
      return { body: REPLY_STOCK };
    });
    await page.goto("/chat/brightnest-cleaning");
    const input = page.getByRole("textbox", { name: "Message BrightNest" });

    await input.fill("How much for a deep clean?");
    await input.press("Enter");
    const card = page.locator(".msg-error").last();
    await expect(card).toContainText("You're sending messages quickly");
    // Disabled with a countdown until Retry-After has passed.
    const retry = card.getByRole("button", { name: /Try again/ });
    await expect(retry).toBeDisabled();
    await expect(retry).toContainText(/Try again in \d+s/);
    await expect(retry).toBeEnabled({ timeout: 4000 });
    await expect(retry).toHaveText("Try again");
    // The card is not an alert region (announced once via the polite announcer; A11Y-7).
    await expect(page.locator(".messages [role='alert']")).toHaveCount(0);
    await expectNoSeriousA11yViolations(page, "chat rate limited");

    await retry.click();
    await expect(page.locator(".msg-error").last()).toContainText("usage budget");
    // The failed card was replaced and the question is still shown once.
    await expect(page.locator(".msg--user")).toHaveCount(1);
    await expect(page.locator(".msg-error")).toHaveCount(1);
    expect(bodies[1]).toMatchObject({ message: "How much for a deep clean?" });
    await expect(page.locator(".msg-error").last().getByRole("link")).toHaveAttribute(
      "href",
      "mailto:support@brightnest-cleaning.example.com",
    );
    await expectNoHorizontalScroll(page);
  });

  test("a fallback reply is styled as an error and Try again re-sends once (VIS-2)", async ({
    page,
  }) => {
    const bodies = await mockChat(page, (_body, n) =>
      n === 0
        ? {
            body: chatText(FALLBACK_TEXT, [], { fallback: true, offerEscalation: true }),
          }
        : { body: REPLY_STOCK },
    );
    await page.goto("/chat/volt-supply");
    await page.locator("#chat-input").fill("Do you have Romex?");
    await page.locator("#chat-input").press("Enter");
    const card = page.locator(".msg-error");
    await expect(card).toContainText("having trouble responding");
    await expect(card.getByRole("button", { name: "Talk to a person" })).toBeVisible();
    await expect(page.locator(".msg--assistant .bubble")).toHaveCount(1); // welcome only
    await expectNoSeriousA11yViolations(page, "chat fallback");

    await card.getByRole("button", { name: "Try again" }).click();
    await expect(page.locator(".msg--assistant .bubble").nth(1)).toContainText("in stock");
    await expect(page.locator(".msg-error")).toHaveCount(0);
    await expect(page.locator(".msg--user")).toHaveCount(1);
    expect(bodies.map((b) => b.message)).toEqual(["Do you have Romex?", "Do you have Romex?"]);
  });

  test("fallback card: email never splits mid-address, no '1 lookup' for a failed turn (R2-6, R2-9)", async ({
    page,
  }) => {
    const email = "support@volt-supply.example.com";
    await mockChat(page, () => ({
      body: chatText(
        `Sorry — the assistant can't answer right now. Use **Talk to a person**, or email ${email} and the team will help.`,
        [
          {
            id: "m1",
            kind: "model",
            label: "Model call failed",
            why: "The model did not answer.",
            outputSummary: "No reply",
            dataRefs: [],
            ok: false,
            error: "llm_unavailable",
            ms: 0,
          },
        ],
        { fallback: true, offerEscalation: true },
      ),
    }));
    await page.goto("/chat/volt-supply");
    await page.locator("#chat-input").fill("Hello?");
    await page.locator("#chat-input").press("Enter");
    const card = page.locator(".msg-error");
    const link = card.getByRole("link", { name: email });
    await expect(link).toHaveAttribute("href", `mailto:${email}`);
    // One line box: the address moves to the next line as a whole (was "support@volt-" /
    // "supply.example.com" at 375 px).
    expect(await link.evaluate((el) => el.getClientRects().length)).toBe(1);
    const box = (await link.boundingBox())!;
    const cardBox = (await card.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);
    await expect(page.locator(".msg__trace-link").first()).toHaveText("See how it answered");
    await expect(page.getByText(/1 lookup/)).toHaveCount(0);
    await expectNoHorizontalScroll(page);
  });

  test("too many hand-off requests: friendly card with the support email, no retry loop (R2-2)", async ({
    page,
  }) => {
    await mockChat(page, () => ({
      status: 429,
      headers: { "Retry-After": "3600" },
      body: {
        error: {
          code: "escalation_limited",
          message:
            "We've already received several requests to talk to a person, so this one wasn't sent. Please email support@greenstripe-lawn.example.com and the team will help.",
        },
      },
    }));
    await page.goto("/chat/greenstripe-lawn");
    await page.locator(".composer__talk").click();
    const prompt = page.getByRole("form", { name: "Talk to a person" });
    await prompt.getByRole("button", { name: "Send to the team" }).click();
    const card = page.locator(".msg-error").last();
    await expect(card).toContainText("We've already received your requests");
    await expect(card.getByRole("link")).toHaveAttribute(
      "href",
      "mailto:support@greenstripe-lawn.example.com",
    );
    await expect(card.getByRole("button")).toHaveCount(0); // no Try again / Talk to a person
    await expectNoSeriousA11yViolations(page, "hand-off limited");
  });

  test("Talk to a person: persistent control, inline email prompt, request_human event (WF-1)", async ({
    page,
  }) => {
    const bodies = await mockChat(page, (body, n) => {
      if ((body.event as { type?: string } | undefined)?.type === "request_human")
        return { body: REPLY_HUMAN };
      if (n === 0) return { status: 503, body: "upstream unavailable" };
      return { body: REPLY_STOCK };
    });
    await page.goto("/chat/brightnest-cleaning");

    // Always available in the composer area, before anything goes wrong.
    const talk = page.locator(".composer__talk");
    await expect(talk).toHaveText("Talk to a person");
    await talk.click();
    const prompt = page.getByRole("form", { name: "Talk to a person" });
    await expect(prompt).toBeVisible();
    await expect(prompt.getByLabel(/Your email/)).toBeFocused();
    await expect(talk).toHaveAttribute("aria-expanded", "true");
    await expectNoSeriousA11yViolations(page, "talk to a person prompt");
    await page.keyboard.press("Escape");
    await expect(prompt).toBeHidden();
    await expect(talk).toBeFocused();

    // From an error card: an invalid email is caught inline, then the request is sent.
    const input = page.getByRole("textbox", { name: "Message BrightNest" });
    await input.fill("Are you there?");
    await input.press("Enter");
    const outage = page.locator(".msg-error").last();
    await expect(outage).toContainText("unavailable right now");
    await outage.getByRole("button", { name: "Talk to a person" }).click();
    await expect(prompt).toBeVisible();
    const email = prompt.getByLabel(/Your email/);
    await email.fill("not-an-email");
    await prompt.getByRole("button", { name: "Send to the team" }).click();
    await expect(prompt.getByText("Enter a valid email address")).toBeVisible();
    await expect(email).toHaveAttribute("aria-invalid", "true");
    await email.fill("Ana@Example.com");
    await prompt.getByRole("button", { name: "Send to the team" }).click();
    await expect(prompt).toBeHidden();

    await expect
      .poll(() => bodies.at(-1)?.event)
      .toEqual({
        type: "request_human",
        contactEmail: "ana@example.com",
      });
    expect(bodies.at(-1)).not.toHaveProperty("message");
    await expect(page.locator(".event-pill").last()).toHaveText("You asked to talk to a person");
    await expect(page.locator(".msg--assistant .bubble").last()).toContainText(
      "passed this conversation",
    );
    await expectNoSeriousA11yViolations(page, "chat after hand-off");
  });

  test("reduced motion: scripted scrolling jumps instead of animating (A11Y-2)", async ({
    page,
  }) => {
    // Record every scroll the app requests, with the behavior it asked for.
    await page.addInitScript(() => {
      const w = window as unknown as { __behaviors: string[] };
      w.__behaviors = [];
      const record = (arg: unknown) => {
        const b =
          arg && typeof arg === "object" && "behavior" in arg
            ? String((arg as ScrollToOptions).behavior)
            : "auto";
        w.__behaviors.push(b);
      };
      const into = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (arg?: boolean | ScrollIntoViewOptions) {
        record(arg);
        return into.call(this, arg as ScrollIntoViewOptions);
      };
      const to = Element.prototype.scrollTo;
      Element.prototype.scrollTo = function (this: Element, ...args: unknown[]) {
        record(args[0]);
        return (to as (...a: unknown[]) => void).apply(this, args);
      } as typeof Element.prototype.scrollTo;
    });
    await mockChat(page, [REPLY_PRODUCT_FORM]);
    await mockCheckout(page);
    const behaviors = async () =>
      page.evaluate(() => (window as unknown as { __behaviors: string[] }).__behaviors);

    // Default motion: the list scrolls smoothly.
    await page.goto("/chat/volt-supply");
    await page.locator("#chat-input").fill("Two rolls please");
    await page.locator("#chat-input").press("Enter");
    await expect(page.getByRole("region", { name: "Secure order form" })).toBeVisible();
    expect(await behaviors()).toContain("smooth");

    // Reduced motion: never "smooth".
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Start over" }).click();
    await page.goto("/chat/volt-supply");
    await page.locator("#chat-input").fill("Two rolls please");
    await page.locator("#chat-input").press("Enter");
    await expect(page.getByRole("region", { name: "Secure order form" })).toBeVisible();
    await page.waitForTimeout(300);
    const reduced = await behaviors();
    expect(reduced.length).toBeGreaterThan(0);
    expect(reduced).not.toContain("smooth");
  });

  test("44px tap targets on phone (A11Y-5)", async ({ page }) => {
    test.skip(!isPhone(page), "phone width only");
    await mockChat(page, (body) => ({
      body: body.message === "book" ? REPLY_SERVICE_FORM : REPLY_STOCK,
    }));
    await mockCheckout(page);
    await page.goto("/chat/mountpro-tv");
    await expectTapTargets(
      page,
      ".starter, .composer__send, .composer__talk, .chat-header__back, .chat-header__actions .btn",
      "chat empty",
    );
    await page.locator("#chat-input").fill("book");
    await page.locator("#chat-input").press("Enter");
    const form = page.getByRole("region", { name: "Secure booking form" });
    await expect(form.locator(".time input:checked")).toHaveCount(1);
    await expectTapTargets(
      page,
      ".chat-header__actions .btn, .msg__trace-link, .cal__nav .icon-btn, .cal__day, .details summary, .time label",
      "booking form",
    );
  });
});
