/**
 * Full-stack "Talk to a person" (WF-1, WF-2): real server, real DB, scripted assistant.
 * The hand-off never goes through the model, so it works in stub mode too.
 */
import { expect, test } from "@playwright/test";
import { ChatResponse, OWNER_ESCALATIONS_ENDPOINT } from "../../src/contracts";
import { sendChat } from "./support/fullstack";
import { ownerPanel, showOwnerView } from "./support/mocks";
import { ownerCookieHeader, signInAsOwner } from "./support/owner-session";

test.describe("full stack: talk to a person", () => {
  test("request_human escalates without the model; owner sees it with the transcript", async ({
    page,
    context,
    baseURL,
    request,
  }) => {
    await page.goto("/chat/flowline-plumbing");
    const first = await sendChat(page, "Can I return a toilet I didn't install?");

    await page.locator(".composer__talk").click();
    const prompt = page.getByRole("form", { name: "Talk to a person" });
    const tag = Date.now().toString(36);
    await prompt.getByLabel(/Your email/).fill(`esc.${tag}@example.com`);
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/chat") && r.request().method() === "POST"),
      prompt.getByRole("button", { name: "Send to the team" }).click(),
    ]);
    expect(res.status()).toBe(200);
    const sent = JSON.parse(res.request().postData() ?? "{}") as Record<string, unknown>;
    expect(sent).toMatchObject({
      conversationId: first.conversationId,
      event: { type: "request_human", contactEmail: `esc.${tag}@example.com` },
    });
    const reply = ChatResponse.parse(await res.json());
    const text = reply.blocks.map((b) => (b.type === "text" ? b.text : "")).join(" ");
    const ticket = /ESC-[A-Z0-9]{4}-[A-Z0-9]{4}/.exec(text)?.[0];
    expect(ticket, text).toBeTruthy();
    await expect(page.locator(".event-pill").last()).toHaveText("You asked to talk to a person");
    await expect(page.locator(".msg--assistant .bubble").last()).toContainText(ticket!);

    // The escalation is listed for the owner, contact masked, linked to the conversation.
    const list = await request.get(OWNER_ESCALATIONS_ENDPOINT.path, {
      headers: { cookie: await ownerCookieHeader() },
    });
    expect(list.status()).toBe(200);
    const items = OWNER_ESCALATIONS_ENDPOINT.schema.parse(await list.json()).items;
    const row = items.find((i) => i.ticketRef === ticket);
    expect(row).toMatchObject({
      businessId: "flowline-plumbing",
      conversationId: first.conversationId,
    });
    expect(row?.contactEmailMasked).toBeTruthy();
    expect(row?.contactEmailMasked).not.toContain(`esc.${tag}`);

    await signInAsOwner(context, baseURL!);
    await page.goto("/owner");
    await showOwnerView(page, "Escalations");
    const tr = ownerPanel(page).locator("tr", { hasText: ticket! });
    await expect(tr).toContainText("Flowline Plumbing Supply");
    await tr.getByRole("button", { name: "Transcript" }).click();
    const dialog = page.getByRole("dialog", { name: "Conversation transcript" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Can I return a toilet I didn't install?");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });
});
