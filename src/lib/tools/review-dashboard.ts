import { z } from "zod";
import { vertex } from "@/lib/vertex";
import { gcp } from "@/lib/gcp";
import { dbReady, dashboardsIn } from "@/lib/firestore";
import type { ToolDefinition } from "./types";

const Input = z.object({
  dashboardId: z
    .string()
    .min(1)
    .describe(
      "ID of the dashboard to review. Use the dashboardId returned by `make_dashboard` (or in the edit context for existing dashboards). The review fetches the dashboard's current state from storage and inspects every chart for quality issues."
    ),
});

/**
 * The model used for review is INDEPENDENT of the primary chat model.
 *
 * Why fixed: review is a short structured-output task (the verifier
 * prompt is ~600 tokens, output is small JSON). Doesn't benefit from
 * top-tier reasoning models. Hardcoding Flash keeps review cost
 * predictable (~$0.001 per review) regardless of whether the chat
 * agent is on Sonnet, Opus, or Pro. Otherwise an Opus-on-chat
 * deployment would pay ~$0.05 per review, which compounds badly.
 *
 * Override via env var if Flash isn't available in the project or you
 * want to compare quality at a higher tier.
 */
const REVIEW_MODEL = process.env.VERTEX_AI_MODEL_REVIEW ?? "gemini-2.5-flash";

/**
 * Maximum chars of dashboard JSON we'll embed in the verifier prompt.
 * 80k chars ≈ 20k tokens — well within Flash's context window with
 * room for the verifier prompt itself. Most dashboards are far under
 * this; the cap is defense against a pathological dashboard with
 * 8 huge specs blowing token budget.
 */
const MAX_DASHBOARD_JSON_CHARS = 80_000;

interface ReviewResult {
  ok: boolean;
  issues: Array<{
    severity: "high" | "medium" | "low";
    description: string;
    suggested_fix: string;
  }>;
}

const VERIFIER_SYSTEM_PROMPT = `You are a dashboard quality reviewer for a B2B SaaS data analytics product. You receive a dashboard's JSON spec and identify quality issues that would degrade the customer experience.

Check for issues like:

- **KPI value formatting mismatch:**
  - Currency tile showing a fractional value like 0.001 (probably a ratio mistakenly labelled as currency)
  - Percent tile showing 0.0% (the renderer handles fractions automatically, so values like 0.03 are FINE — only flag if value is literally zero)
  - Number tile with unit "%" but value much less than 1 (formatting mismatch)
- **Empty or near-empty charts:**
  - Time-series with 0-1 data points (need wider date range)
  - Bar / pie with 0 or 1 categories (not a meaningful breakdown)
- **Missing or generic labels:**
  - Chart titles like "Chart 1", "Untitled", empty strings
  - Pie segments with names like "Item 1", "0", "1" (raw indices, not data labels)
- **Mismatched dashboard composition:**
  - User asked for a "dashboard" but result is just KPIs — missing time-series and breakdown charts (the content floor rule should catch this but defence-in-depth)
  - KPI tiles + time-series chart use clearly different metrics (e.g. KPI = "Total Revenue", chart = "Average Order Value" with no obvious link)
- **Schema / structure issues:**
  - Series of type "kpi" with data array longer than 1 (kpi is single-value by definition)
  - xAxis.data length doesn't match series[0].data length on a line/bar chart

DON'T flag minor wording / aesthetic preferences. Only flag real issues that would visibly degrade the dashboard for a business user. If the dashboard would be useful as-is, set "ok": true.

Severity guide:
- **high** — the dashboard is broken or shows misleading info (wrong format, single-point line chart, blank labels). Fix required.
- **medium** — quality issue worth noting but the dashboard is still usable (mismatched metrics across charts, mildly generic title)
- **low** — minor polish (a chart title could be more descriptive)

Return EXACTLY one JSON object matching this shape:

{
  "ok": true | false,
  "issues": [
    { "severity": "high" | "medium" | "low", "description": "...", "suggested_fix": "..." }
  ]
}

"ok" is true when there are no "high" severity issues. Medium and low issues don't flip "ok" to false. Empty issues array is fine if everything looks good.`;

/**
 * Dashboard self-review tool — the verifier step in the agent loop.
 *
 * Lives in the standard agent toolset so the chat agent can call it
 * after `make_dashboard` succeeds. Returns structured findings the
 * agent then decides what to do with — fix high-severity issues via
 * `update_dashboard`, mention medium/low issues in its summary, or
 * ship the dashboard as-is when "ok" is true.
 *
 * The verifier uses a separate model (Gemini Flash by default) for
 * cost predictability regardless of the primary chat model. The call
 * is fire-and-forget from the dashboard's perspective — if review
 * fails or returns malformed output, we degrade gracefully to
 * "ok: true, review skipped" rather than blocking the dashboard from
 * shipping. The customer should never see "review failed" — they
 * should see a working dashboard.
 *
 * Iteration discipline (enforced by the system prompt, not by this
 * tool):
 *   - Agent calls review_dashboard ONCE per dashboard creation.
 *   - If high-severity issues exist, agent calls update_dashboard
 *     ONCE to fix them. No re-review after update — strict single
 *     iteration.
 *   - Total tool budget per dashboard: make + review + (optional) update.
 *
 * Skip via prompt language: when the user's request contains phrases
 * like "quick", "just ship it", "first attempt is fine", "no need to
 * iterate", the system prompt instructs the agent to skip the review
 * call entirely. This is a per-request opt-out — not an env var —
 * because different requests have different quality bars.
 */
export const reviewDashboardTool: ToolDefinition = {
  name: "review_dashboard",
  description:
    "Self-review a dashboard you just created or updated. Returns a structured quality report identifying real issues (wrong KPI formats, empty charts, generic labels, etc.). Call this ONCE after make_dashboard succeeds — if it returns high-severity issues, call update_dashboard ONCE to fix them, then ship. If the user asked for something 'quick' or said 'first attempt is fine', skip this tool entirely. Never call review_dashboard twice for the same dashboard.",
  inputSchema: Input,
  handler: async (raw, ctx) => {
    const { dashboardId } = Input.parse(raw);
    await dbReady();

    // 1. Fetch the dashboard from Firestore — workspace-scoped lookup
    // so a smuggled id from one workspace can't reach another.
    const ref = dashboardsIn(ctx.clientId, ctx.workspaceId).doc(dashboardId);
    const snap = await ref.get();
    if (!snap.exists) {
      // Don't throw — the agent should be able to ship the dashboard
      // even if the review tool can't find it (maybe a timing issue
      // with Firestore consistency). Return a clean "skipped" result.
      const skipped: ReviewResult = {
        ok: true,
        issues: [
          {
            severity: "low",
            description: `Dashboard ${dashboardId} not found for review (may not have committed yet).`,
            suggested_fix: "Proceed with the original dashboard; consider asking the user to verify it looks right.",
          },
        ],
      };
      return { content: skipped };
    }

    const dashboardData = snap.data() as {
      title?: string;
      description?: string | null;
      charts?: Array<{ order: number; title: string; spec: unknown; colSpan?: string }>;
    };

    // 2. Compose the verifier prompt with the dashboard JSON embedded.
    let dashboardJson = JSON.stringify(
      {
        title: dashboardData.title,
        description: dashboardData.description ?? null,
        charts: dashboardData.charts ?? [],
      },
      null,
      2
    );
    if (dashboardJson.length > MAX_DASHBOARD_JSON_CHARS) {
      // Defensive truncation. Should never happen in practice (max
      // 8 charts × few KB each) but protects against pathological
      // dashboards from blowing the verifier's token budget.
      dashboardJson = dashboardJson.slice(0, MAX_DASHBOARD_JSON_CHARS) + "\n...(truncated)";
    }

    const userPrompt = `Review this dashboard for quality issues. Return JSON only.\n\n\`\`\`json\n${dashboardJson}\n\`\`\``;

    // 3. Make the verifier LLM call. Use a fixed cheap model regardless
    // of primary chat model. Use the workspace's vertex region default
    // — review doesn't need strict residency the way customer data
    // does (the dashboard JSON is already in their workspace).
    try {
      const client = vertex(gcp.vertexRegion);
      const model = client.getGenerativeModel({
        model: REVIEW_MODEL,
        systemInstruction: { role: "system", parts: [{ text: VERIFIER_SYSTEM_PROMPT }] },
        generationConfig: {
          // Force JSON response — Gemini supports a schema-enforced
          // JSON mode that's far more reliable than asking the model
          // to "return JSON" in prose.
          responseMimeType: "application/json",
        },
      });
      const result = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      });
      const text = result.response.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      let parsed: ReviewResult;
      try {
        parsed = JSON.parse(text) as ReviewResult;
      } catch {
        // Malformed JSON from the verifier — degrade gracefully.
        console.warn("[review_dashboard] verifier returned malformed JSON", {
          textPreview: text.slice(0, 200),
        });
        const skipped: ReviewResult = {
          ok: true,
          issues: [
            {
              severity: "low",
              description: "Review output malformed; proceeding without findings.",
              suggested_fix: "Ship the dashboard as-is.",
            },
          ],
        };
        return { content: skipped };
      }

      // Defensive normalisation — make sure the structure is what we
      // promised the agent. Fill in missing fields, clamp severity
      // to the enum, drop garbage.
      const normalised: ReviewResult = {
        ok: Boolean(parsed.ok),
        issues: Array.isArray(parsed.issues)
          ? parsed.issues
              .filter((i) => i && typeof i === "object")
              .map((i) => ({
                severity:
                  i.severity === "high" || i.severity === "medium" || i.severity === "low"
                    ? i.severity
                    : "low",
                description: typeof i.description === "string" ? i.description : "(no description)",
                suggested_fix:
                  typeof i.suggested_fix === "string" ? i.suggested_fix : "(no suggestion)",
              }))
          : [],
      };

      console.log("[review_dashboard] completed", {
        dashboardId,
        ok: normalised.ok,
        issueCount: normalised.issues.length,
        highCount: normalised.issues.filter((i) => i.severity === "high").length,
      });

      return { content: normalised };
    } catch (err) {
      // Review LLM call failed entirely — log + ship anyway. We never
      // want a verifier outage to block a customer's dashboard.
      console.error("[review_dashboard] verifier call failed", {
        dashboardId,
        error: err instanceof Error ? err.message : String(err),
      });
      const skipped: ReviewResult = {
        ok: true,
        issues: [],
      };
      return { content: skipped };
    }
  },
};
