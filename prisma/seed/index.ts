/**
 * Demo seed — idempotent: wipes all demo data and reloads it.
 *
 *   npm run seed       (applies migrations first)
 *   npm run db:reset   (drops the DB, migrates, seeds)
 *
 * Loads: 5 businesses, 25 electrical + 25 plumbing products, service rows matching
 * src/config/pricing.ts, contractors, and 60 days of hourly slots per contractor.
 * No customers, orders or bookings are seeded (no PII, real-looking or otherwise).
 * UsageDay rows (daily LLM spend) are intentionally kept so reseeding cannot reset the budget.
 *
 * Slot model: one Slot = one 60-minute start position for one contractor, generated for each
 * open hour inside the business's bookingHours (local time, converted to UTC). A booking of
 * N minutes occupies ceil(N/60) consecutive slots of one contractor (see prisma/schema.prisma).
 * Seeded "booked" slots with no bookingId represent jobs booked outside Oasis; they make the
 * test dates in ./test-dates.ts fully booked or fragmented.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BUSINESSES } from "../../src/config/businesses";
import { BOOKING_HORIZON_DAYS, SLOT_MINUTES } from "../../src/config/constants";
import { SERVICE_CATALOG } from "../../src/config/pricing";
import { createPrismaClient } from "../../src/db-client";
import { addDays, minutesOf, timeOf, weekdayOf, zonedTimeToUtc } from "../../src/lib/tz";
import { PRODUCTS_BY_BUSINESS } from "./products";
import { computeTestDates, SEED_META_PATH, type ServiceTestDates } from "./test-dates";

if (process.env.DATABASE_URL === undefined) {
  try {
    process.loadEnvFile(".env");
  } catch {
    // no .env: env.ts defaults apply
  }
}

const CONTRACTORS: Record<string, string[]> = {
  "mountpro-tv": ["Marco R.", "Dana K."],
  "greenstripe-lawn": ["Luis M.", "Priya S.", "Owen T."],
  "brightnest-cleaning": ["Ana P.", "Grace L.", "Tomas W."],
};

type SlotRow = {
  businessId: string;
  contractorId: string;
  startsAt: Date;
  endsAt: Date;
  status: string;
};

async function main(): Promise<void> {
  const prisma = createPrismaClient();
  const started = Date.now();
  const now = new Date();
  const testDates = computeTestDates(now, BOOKING_HORIZON_DAYS);

  try {
    // ---- wipe (children first) ------------------------------------------------
    await prisma.$transaction([
      prisma.payment.deleteMany(),
      prisma.message.deleteMany(),
      prisma.notification.deleteMany(),
      prisma.escalation.deleteMany(),
      prisma.checkoutDraft.deleteMany(),
      prisma.booking.deleteMany(),
      prisma.order.deleteMany(),
      prisma.slot.deleteMany(),
      prisma.customer.deleteMany(),
      prisma.conversation.deleteMany(),
      prisma.contractor.deleteMany(),
      prisma.service.deleteMany(),
      prisma.product.deleteMany(),
      prisma.business.deleteMany(),
    ]);

    // ---- businesses ---------------------------------------------------------------
    await prisma.business.createMany({
      data: BUSINESSES.map((b) => ({
        id: b.id,
        name: b.name,
        kind: b.kind,
        timezone: b.timezone,
        supportEmail: b.supportEmail,
        notifyEmail: b.notifyEmail,
        notifyPhone: b.notifyPhone,
      })),
    });

    // ---- products -------------------------------------------------------------
    let productCount = 0;
    for (const [businessId, products] of Object.entries(PRODUCTS_BY_BUSINESS)) {
      const res = await prisma.product.createMany({
        data: products.map((p) => ({ ...p, businessId, active: true })),
      });
      productCount += res.count;
    }

    // ---- services -------------------------------------------------------------
    const services = await prisma.service.createMany({
      data: SERVICE_CATALOG.map((s) => ({
        businessId: s.businessId,
        code: s.code,
        name: s.name,
        description: s.description,
      })),
    });

    // ---- contractors + slots ----------------------------------------------------
    let slotCount = 0;
    let blockedCount = 0;
    for (const business of BUSINESSES.filter((b) => b.kind === "service")) {
      const names = CONTRACTORS[business.id] ?? [];
      const contractors = [];
      for (const name of names) {
        contractors.push(
          await prisma.contractor.create({ data: { businessId: business.id, name } }),
        );
      }
      const fixtures = testDates.services[
        business.id as keyof typeof testDates.services
      ] as ServiceTestDates;

      const rows: SlotRow[] = [];
      for (let i = 0; i < BOOKING_HORIZON_DAYS; i++) {
        const date = addDays(fixtures.today, i);
        const wd = weekdayOf(date);
        const hours = business.bookingHours.filter((h) => h.day === wd);
        for (const h of hours) {
          const startMins: number[] = [];
          for (
            let m = minutesOf(h.open);
            m + SLOT_MINUTES <= minutesOf(h.close);
            m += SLOT_MINUTES
          ) {
            startMins.push(m);
          }
          contractors.forEach((c, ci) => {
            startMins.forEach((m, si) => {
              const startsAt = zonedTimeToUtc(date, timeOf(m), business.timezone);
              const endsAt = new Date(startsAt.getTime() + SLOT_MINUTES * 60_000);
              let status = "open";
              if (fixtures.fullyBooked.includes(date)) status = "booked";
              if (fixtures.lastSlotOnly === date) {
                const isLast = si === startMins.length - 1;
                status = ci === 0 && isLast ? "open" : "booked";
              }
              if (fixtures.fragmented === date) status = si % 2 === 0 ? "booked" : "open";
              if (status === "booked") blockedCount++;
              rows.push({ businessId: business.id, contractorId: c.id, startsAt, endsAt, status });
            });
          });
        }
      }
      const res = await prisma.slot.createMany({ data: rows });
      slotCount += res.count;
    }

    // ---- fixture metadata for tests/evals -------------------------------------------
    mkdirSync(path.dirname(SEED_META_PATH), { recursive: true });
    writeFileSync(SEED_META_PATH, JSON.stringify(testDates, null, 2) + "\n");

    console.log(
      `Seeded ${BUSINESSES.length} businesses, ${productCount} products, ${services.count} services, ` +
        `${Object.values(CONTRACTORS).flat().length} contractors, ${slotCount} slots ` +
        `(${blockedCount} pre-booked fixtures) in ${Date.now() - started} ms.`,
    );
    for (const [id, t] of Object.entries(testDates.services)) {
      const extra = [
        t.lastSlotOnly ? `lastSlotOnly=${t.lastSlotOnly}` : "",
        t.fragmented ? `fragmented=${t.fragmented}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      console.log(
        `  ${id} (${t.timezone}): today=${t.today} fullyBooked=${t.fullyBooked.join(",")} ${extra}`,
      );
    }
    console.log(`  Test dates written to ${SEED_META_PATH}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
