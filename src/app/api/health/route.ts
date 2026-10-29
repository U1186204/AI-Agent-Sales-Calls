import { NextResponse } from "next/server";
import { getPrisma } from "@/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Liveness + DB readiness probe (used by Docker/hosting health checks). No PII. */
export async function GET() {
  try {
    const businesses = await getPrisma().business.count();
    return NextResponse.json({ ok: true, db: "up", businesses });
  } catch {
    return NextResponse.json({ ok: false, db: "down" }, { status: 503 });
  }
}
