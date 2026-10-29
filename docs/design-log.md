# Design log

Screenshots come from `OASIS_SCREENSHOTS=1 npx playwright test ui-screenshots` (all API
responses mocked) at 375 / 768 / 1440 into `.artifacts/screenshots/` (gitignored), and are
deleted after each round. States: home, 404, status (empty + found), owner login (errors),
chat (empty, reply, trace sheet), product form (empty, errors, review, success), booking form
(calendar + times), and all seven owner tabs.

## Round 0 — before the first screenshot pass (caught by the e2e suite)

- **375px horizontal scroll on chat.** The chat header (back, name, "Trace", "Start over")
  forced the grid wider than the viewport (401px). Fix: `grid-template-columns: minmax(0,1fr)`
  on the chat page and an icon-only "Start over" below 600px (label kept for screen readers).
- **Ghost button hover failed AA.** Accent text on the accent tint is 4.47:1. Fix: hover uses
  `--accent-ink` (7.4:1).
- **Owner availability tiles failed AA.** Muted 11px labels on tinted tiles. Fix: `--ink-2`.
- **Link in success copy relied on color.** Fix: links in running text are underlined.

## Round 1

Critique:

1. Home: the "Every reply shows its work" line sat directly under the three steps at lede
   size, read like a stray paragraph and was the most important claim on the page.
2. Home: the "Track an order or booking" button in the gray band used the gray secondary
   style, so it disappeared into the band and looked like plain text.
3. Chat: when the page needed to scroll (forms), `scrollIntoView` also scrolled the document,
   pushing the chat header off screen (desktop review shot had no header; phone shot had a
   dead white strip under the composer).
4. Trace: the "show me how it answered" highlight drew a permanent teal ring on every card
   in the group. Heavy, and it stayed after the user had found the group.
5. Calendar: unavailable days were struck through. Thirty strikethroughs is visual noise; the
   tinted available days already carry the meaning.
6. Review: tax read "Tax (7.50%)". Unnecessary precision.
7. Owner overview: stat tiles rendered list bullets in the gutter (unstyled `ul`).
8. Owner on phone: tabs scroll horizontally, and the selected tab could sit off screen.

Fixes: (1) turned it into an accent-tinted callout with the trace icon and 48px of air;
(2) new `btn--light` (white, soft shadow) for buttons on tinted surfaces; (3) the document
never scrolls on the chat page (`html/body:has(.chat-page) { overflow: hidden }`), only the
message list does; (4) highlight is a softer 45% ring that fades after 1.8 s; (5) unavailable
days are plain light-gray numbers; (6) tax rate trimmed to "7.5%"; (7) reset list styles on
`.stats`; (8) selecting a tab scrolls it into view.

## Round 2

Critique:

1. The chat document still scrolled (desktop review shot again had no header; phone success
   shot had a ~70px dead strip under the composer). Root cause was not the scroll call but
   `.visually-hidden` live regions: absolutely positioned with no positioned ancestor, they
   sat at the bottom of the long message list in document coordinates and stretched the
   document. `overflow: hidden` on `html` doesn't stop programmatic scrolling.
2. Review: contact/items/address blocks stretched to equal row heights, leaving a big empty
   gray area under "Items".
3. Success: the "what happens next" bullets floated loose under centered text, unanchored.
4. Chat empty state: a disabled, washed-out "Start over" button sat in the header before
   there was anything to start over. A visible control that does nothing is a dead button.

Fixes: (1) `.chat-page`, `.chat-main`, `.chat-scroll` are positioned containers and the page
clips overflow, so hidden nodes stay inside the scroller; (2) `align-items: start` on the
review grid; (3) next steps live in a full-width gray panel, left aligned; (4) "Start over"
only renders once the conversation has messages.

## Round 3

Critique:

1. Desktop success shot: the chat header and the top of the trace panel were still shifted
   up by ~35px during the smooth scroll that follows confirm. `overflow: hidden` containers
   remain scrollable by script, so a transient overflow let `scrollIntoView` move them.
2. Tablet home: the three service cards wrapped 2 + 1, leaving BrightNest alone next to an
   empty cell.
3. Owner sign in: an empty live-region wrapper took a grid slot, adding a 28px gap above
   "Username" that made the panel look top-heavy.
4. Short pages (login, 404): the footer floated mid-screen with blank white below it.
5. Owner availability on phone: "Sun 11" wrapped to two lines while "Mon 5" didn't, so
   tile heights and the count baseline were ragged.

Fixes: (1) `overflow: clip` on the chat page (and html/body while it's mounted) — clip
forbids programmatic scroll; (2) on 768–1023px an odd last service card spans both columns;
(3) the login error is a `role="alert"` node inserted only when needed (announced on
insert), no empty wrapper; (4) body is a flex column and main grows, so the footer sits at
the bottom; (5) tiles always stack weekday / date / count on three lines.

## Round 4 — verification

Re-shot all states at 375 / 768 / 1440. Confirmed: chat header and trace panel stay fixed
through confirm and auto-scroll; tablet home grid has no orphan; login panel spacing is even;
footer pinned on short pages; availability tiles align. Remaining note, not a product bug:
Playwright's full-page capture of the status page draws the sticky header mid-page because
the page had scrolled to the result before capture. No new issues; nothing changed.

## Round 5 — verify fixes (a11y-visual + workflows reports)

New states shot at 375 / 768 / 1440: chat rate-limit + fallback cards, "Talk to a person"
prompt and its sent state, booking review, all eight owner views (new Escalations), and the
transcript drawer. `smoke.spec.ts` now only screenshots with `OASIS_SCREENSHOTS=1`, so a normal
run no longer leaves the stray `*-home.png` files behind (all deleted, with this round's shots).

Critique:

1. Rate-limit card: the countdown read "Try again in 30  s" (JSX whitespace around the number).
2. "Talk to a person" appeared three times on screen with two failure cards (each card plus the
   composer). Repetition dilutes it.
3. The support address still broke at its own hyphen ("support@mountpro-" / "tv.example.com").
4. The focus ring on step headings (3px) looked heavy around a 20px title.
5. Owner tables: the mono "Ticket"/"SKU" headers used the code font; dates wrapped to four lines
   at 768 ("Oct 6, / 1:37 / PM / EDT"); the masked contact broke mid-token ("j***@e***.c / om");
   the 8-column Escalations table was clipped at 768 by the card's `overflow: hidden`.
6. The demo-credentials banner (neutral `notice--warn`) disappeared into the gray owner page.
7. A single review warning rendered with a stray list bullet.

Fixes: (1) one text node; (2) the card button only on the newest failure card, the composer
control is always there; (3) the address is an inline-block that only breaks if it can't fit a
line; (4) 2px heading ring; (5) table headers use the UI font, dates and contacts `nowrap`, and
`.table-wrap` scrolls horizontally instead of clipping; (6) the banner is a white card with the
attention icon; (7) no bullets in notice lists.

Kept, with reason: on 768 the Escalations table scrolls sideways inside its card (8 columns
don't fit; stacking only kicks in below 768). Same pattern as the other owner tables, and the
page itself never scrolls sideways. The status page's mid-page sticky header in full-page
captures is still the Playwright capture artifact noted in round 4.

System changes this round (from the a11y/visual report): control borders use
`--control-border` (#86868b, 3.6:1); text fields get a solid 2px accent ring on focus, also when
invalid (red 2px border + accent ring); colour is one accent + neutrals + a single `--attention`
token (warn/ok tokens removed, no row fills, status in words); calendar availability is bold +
dot, not tint alone; 44px tap targets under `(pointer: coarse), (max-width: 767px)`; owner views
use a "View" select below 1024px and tabs (all eight fit) above.

## Round 6 — booking form "Service details"

Screens: `17-booking-form`, `17c-booking-details-open`, `17d-booking-details-conditions`,
`17e-booking-details-updated` at 375 / 768 / 1440 (`ui-screenshots`, mocked).

Critique:

1. Tile durations said "1 h 15 min" while the form said "2 hr 30 min": two duration formats on
   one card.
2. "2-person crew" wrapped mid-label ("2-" / "person crew"), and would have repeated on every
   BrightNest tile, where every tier sends two cleaners.
3. A lone last choice (Full-motion mount) stretched across the whole row.
4. On touch screens the tile under the finger kept its hover border after a tap, so a tile that
   wasn't chosen looked chosen.
5. Two tile columns on a 375 phone (tried) wrapped names and durations into ragged three-line
   tiles.
6. Rows with a stepper started their text at the left edge, rows with a checkbox 32px further
   in: the list looked ragged.
7. Open by default, the section put about 20 tab stops between the form heading and the
   calendar for keyboard users, and pushed scheduling below the fold.

Fixes: (1) one formatter (`ui-lib/format`) for option labels; (2) crew on its own line and only
where it differs between tiers; (3) choices are a grid of equal columns; (4) hover styles only
under `(hover: hover)`; (5) back to one column below ~350px of content; (6) every control
(checkbox or stepper) sits on the right edge, so all option text shares one left edge; (7) the
section starts as a one-line summary ("Large (56"–70") · Tilting mount supplied · Above
fireplace") with an "Edit" pill; one Tab stop, then the calendar.

## Round 7 — guided chat cards

Screens: `30-a-mount-picker`, `30-b-mount-quote`, `30-c-mount-times`, `30-d-clean-picker`,
`30-e-volt-products`, `30-f-volt-cart` at 375 / 768 / 1440, captured from the real server with
the scripted assistant (`OASIS_SCREENSHOTS=1 npx playwright test fullstack-guided`).

Critique:

1. In the chat card the size tiles packed into four narrow columns: "Extra large (71"–" / "85")".
2. The price card repeated the whole "why does a fireplace cost more" paragraph plus the
   labor/materials and duration notes: a tall card for a short answer.
3. The cart listed each item twice (stepper row, then the same line in the price table).
4. After the price card arrived, the original picker was still live: two places to change the
   same options.
5. A clicked card button became disabled, and keyboard focus fell back to the page.

Fixes: (1) tiles need 176px, so three columns in a card, one on a phone; (2) `QuoteSummary
compact` keeps short line notes ("Labor", "Materials (taxed)") and drops long explanations and
notes the card already shows; the "why" stays one click away in the picker; (3) the line amount
sits on the stepper row and the table shows only subtotal, shipping, tax and total; (4) each
flow moves forward one reply at a time: only the newest reply's cards take clicks, older ones
stay as a quieter read-only record; (5) focus moves to the new card's title after a card click
(typed messages keep focus in the composer).

Kept, with reason: the trace panel still shows "1 h 30 min" in tool summaries (model-facing
domain wording, unchanged by this work).
