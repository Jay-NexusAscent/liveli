import { addToWaitlist, isValidEmail } from "@/lib/waitlist";

export const runtime = "nodejs";

/**
 * Public waitlist capture. No auth — prospective users who hit the
 * signup cap submit their email here so we can invite them when
 * registration reopens. Stored idempotently (see addToWaitlist).
 */
export async function POST(req: Request) {
  let email: unknown;
  try {
    ({ email } = (await req.json()) as { email?: unknown });
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (typeof email !== "string" || !isValidEmail(email)) {
    return Response.json({ error: "Enter a valid email address" }, { status: 400 });
  }

  try {
    await addToWaitlist(email, { source: "sign-up" });
  } catch (err) {
    console.error("[waitlist] failed to store email", {
      err: err instanceof Error ? err.message : String(err),
    });
    return Response.json({ error: "Could not join the waitlist" }, { status: 500 });
  }

  return Response.json({ ok: true });
}
