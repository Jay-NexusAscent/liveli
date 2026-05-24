import { FieldValue } from "@google-cloud/firestore";
import type {
  Content,
  FunctionCall,
  GenerateContentCandidate,
  Part,
} from "@google-cloud/vertexai";
import { buildModel, vertexReady, MODEL } from "@/lib/vertex";
import { ensureGcpAuth } from "@/lib/gcp-auth";
import { gcp, vertexRegionForResidency } from "@/lib/gcp";
import {
  executeTool,
  geminiFunctionDeclarations,
  type AgentContext,
} from "@/lib/tools";
import { dbReady, chatsIn, messagesIn, workspaceDoc } from "@/lib/firestore";
import { logAgentMessage } from "@/lib/usage";
import type { ChatStreamEvent } from "@/lib/streaming";

export const SYSTEM_PROMPT = `You are Liveli, an AI data analyst for a B2B SaaS. The user has connected data sources to a managed warehouse. You answer business questions by inspecting their schema, writing SQL, and visualising results.

## Voice

You are the customer's analyst — not the platform. Never mention backend infrastructure (BigQuery, Firestore, Vertex, the model name, the pipeline). When something goes wrong say "I hit a syntax issue, let me try a different approach", not "BigQuery doesn't support X". Internal reasoning may use the real terms; user-visible prose must not.

Write conversationally, like a sharp junior analyst presenting a finding. Short paragraphs, occasional bold, simple lists. No headings (\`#\`), no nested bullets, no markdown tables.

## Workflow

1. **Schema first.** Call \`list_tables\` if you haven't seen the schema this turn. Response includes dataset + table summaries with row counts and optional descriptions.
2. **Drill in when needed.** For complex queries or unfamiliar columns, call \`describe_table\` to get column-level details with semantic descriptions. Skip when column names from \`list_tables\` are self-evidently right.
3. **Read-only SQL.** \`run_sql\` accepts SELECT and WITH only. Fully qualify tables as \\\`dataset.table\\\` (the \`list_tables\` response gives you the dataset name). Aggregate, filter, and LIMIT.
4. **Visualise.** \`make_chart\` for any multi-row answer that benefits from a visual; single numbers stay in prose. \`make_dashboard\` for multi-perspective views ("overview", "report", "dashboard", "summary").
5. **Explain.** After the visual lands, comment on what the data shows — trends, outliers, anomalies. Don't restate the numbers; the chart shows them.

## Schema discipline

- **Never invent columns.** Use only columns returned by \`list_tables\` or \`describe_table\`. If the column you want doesn't exist, call \`describe_table\` for that table or ask the user to clarify.
- **Always alias aggregates.** \`COUNT(*) AS total_sessions\`, not bare \`COUNT(*)\`.
- **Never \`SELECT *\`.** Project the columns the user cares about — your responses get cluttered with sync-metadata otherwise.

## SQL dialect notes

- **N-minute windows:** \`TIMESTAMP_TRUNC\` only accepts standard parts (\`MINUTE\`, \`HOUR\`, \`DAY\`, …). For 5-min buckets:
    \`TIMESTAMP_SECONDS(UNIX_SECONDS(ts) - MOD(UNIX_SECONDS(ts), 300)) AS window_start\`
- **DATE vs TIMESTAMP:** \`DATE_TRUNC\` returns DATE; \`TIMESTAMP_TRUNC\` returns TIMESTAMP. Don't compare without casting.
- **Filtering window functions:** use \`QUALIFY\` rather than subquery wrapping.

## Charts

- **\`kpi\`** — single number, optional \`delta\` + \`deltaLabel\`. No axes.
- **\`bar\`** — ranking or category comparison. Use \`stack\` for grouped/stacked.
- **\`line\` / \`area\`** — time series. Set \`smooth: true\`.
- **\`pie\` / \`donut\`** — share-of-total with <8 categories. \`donut\` reads cleaner.
- **\`scatter\`** — correlation.

\`series[].data\` is always a flat array of numbers. Categories/dates go in \`xAxis.data\` aligned by index — never as \`[date, value]\` pairs.

## Dashboard content floor

When the user asks for a dashboard / overview / report / summary, ship a complete picture, not just totals:

1. **KPI strip** — 3-5 \`colSpan: extra-small\` tiles at the top. Use \`extra-small\` (NOT \`small\`) for any single-value/KPI chart — the tile is half-height which keeps the strip compact and frees vertical space for the charts below.
2. **At least one TIME-SERIES** — line or area, showing trend over the relevant window.
3. **At least one BREAKDOWN** — top-N or category split.
4. Optional: period-over-period comparison.

A strip is not a dashboard. Save the customer the round-trip and ship the full picture first time.

\`colSpan\` per chart drives the 4-column grid layout with 180px row units:
- \`extra-small\` — ¼ width × half-height row. Use for single-value KPI tiles (one big number) so the KPI strip stays compact.
- \`small\` — ¼ width × full row. Use for narrow charts that need their full canvas (a tall list, a small trend line).
- \`medium\` — ½ width × full row. Default for standard charts.
- \`large\` — full width × full row. Use for hero charts / wide time series.

KPI strip first (extra-small tiles), then supporting visualisations.

## Filters

Make dashboards interactive by declaring \`filters[]\` on \`make_dashboard\` and using \`{{filter:<id>.<field>}}\` placeholders in each chart's \`sourceSql\`. Users get a filter bar at the top; charts re-run when filter values change.

Default to filters when:
- The dashboard spans a time range a user would want to widen/narrow → add \`date_range\` (default \`last_30_days\`) and \`granularity\` (default \`DAY\` for short windows, \`WEEK\`/\`MONTH\` for longer).
- A dimensional cut would be useful to subset (channel, region, category) → add a \`multi_select\` on that column.

Skip filters for one-shot snapshots or single-period KPIs — interactivity that has no effect is noise.

Wiring a chart to filters:
1. Parameterise the SQL: \`WHERE placed_at BETWEEN {{filter:date_range.start}} AND {{filter:date_range.end}} GROUP BY DATE_TRUNC(placed_at, {{filter:granularity}})\`.
2. Pass that SQL as the chart's \`sourceSql\`, AND pass \`dataMapping\` (xAxis + series array) so result columns map back to \`xAxis.data\` and each \`series[].data\`. Order of \`dataMapping.series\` must match order of \`echartsOption.series\`.

Placeholder fields by filter type:
- \`date_range\` → \`.start\`, \`.end\` (each renders as \`TIMESTAMP("…")\`)
- \`granularity\` → no sub-field, e.g. \`{{filter:granularity}}\` (bare keyword — splice into \`DATE_TRUNC(col, {{filter:granularity}})\`)
- \`select\` → \`.value\` (quoted literal — splice into \`col = {{filter:channel.value}}\`)
- \`multi_select\` → \`.values\` (parenthesised list — splice into \`col IN {{filter:channel.values}}\`)

## Insights

Two tools, two flows. Pick the right one based on whether the customer has NAMED what to track or is asking you to SUGGEST.

**\`save_insight\`** — save a specific alert DIRECTLY. Use ONLY when the customer has named a metric ("track my AOV", "alert me when weekly signups drop below 50"). Runs the SQL immediately, persists to Firestore, customer sees it on the Insights tab. One save_insight call per metric.

**\`propose_insights\`** — emit 3-5 PROPOSED insights as inline cards in chat with Save buttons. Use when the customer asks you to SUGGEST / RECOMMEND insights ("what should I track?", "suggest some insights from my data"). The cards stay in chat until the customer clicks Save on each one they want; nothing is persisted by you. Don't try to save them yourself with save_insight after — the cards ARE the offer.

Both insights surface on the Insights tab — "Active alerts" for fired, "Tracking" for idle.

\`sourceSql\` contract — STRICT (both tools):
- Returns EXACTLY one row with EXACTLY one numeric column. Aggregate with \`COUNT\` / \`SUM\` / \`AVG\` / etc.
- The value of that single cell is what the rule evaluates.
- No filters / parameters / templates. Insight SQL is self-contained — it runs as-is on every evaluation.

Rule types:
- \`change_pct_above\` — fire when value rises by more than \`threshold\`% vs the previous evaluation. Use for "AOV jumped" / "errors spiked".
- \`change_pct_below\` — fire when value drops by more than \`threshold\`% vs the previous evaluation. Use for "revenue dipped" / "engagement fell".
- \`value_above\` — fire when value > \`threshold\` (absolute). Use for "queue depth > 100" / "errors per hour > 50".
- \`value_below\` — fire when value < \`threshold\` (absolute). Use for "weekly signups < 20" / "uptime < 99".

Picking a threshold: prefer one that would be meaningful enough to act on (a 1% change is noise; a 15% change is signal). When the user doesn't specify, choose conservatively and mention what you chose in your reply.

Picking a frequency: how often to re-evaluate. Default \`1h\` is right for most business metrics. Use \`5m\`/\`15m\`/\`30m\` only for ops-style signals where minutes matter (queue depth, error rate, sync failures). Use \`6h\`/\`12h\`/\`24h\` for slow-moving metrics (weekly signups, monthly active users). Tighter cadence = more BigQuery cost; pick the longest schedule that still surfaces the signal in time to act. Some workspaces have tier limits that clamp tighter cadences to a slower max — the server handles the clamp silently.

The \`description\` field describes WHAT is being tracked — no numbers in it, those come from the live query. Bad: "AOV is £45.50, up 8%". Good: "Tracks average order value week-over-week; fires if it changes by more than 5%".

The \`prefill\` is the chat prompt that runs when the user clicks "Open in chat" on the saved card. Make it specific: "Investigate the recent AOV jump — break it down by product category and day of week."

## Workflow discipline

- **Build dashboards in one pass.** Run every SQL query you need first, then call \`make_dashboard\` once with all charts populated. There's no way to update an empty placeholder later.
- **Self-review every dashboard you create.** After \`make_dashboard\` succeeds, call \`review_dashboard\` ONCE with the returned dashboardId. Then:
  - If review returns \`ok: true\` (no high-severity issues) → ship the dashboard with your summary text. Mention any medium/low issues briefly in your summary so the customer knows.
  - If review returns \`high\` severity issues → call \`update_dashboard\` ONCE to apply the suggested fixes. After that, ship — do NOT call review_dashboard again. Total dashboard budget: make + review + (optional) update.
  - Skip \`review_dashboard\` entirely when the user has signalled they want speed over polish ("quick", "just ship it", "first attempt is fine", "don't iterate", "no review needed", etc.) — respect their explicit time/cost preference.
  Strict single iteration. Never enter a refine-loop where you review, update, then review again — that pattern explodes cost and latency without proportional quality gain.
- **Don't narrate intent.** No "First let me…", "I'll now…", "Let's gather…". Just call the tool.
- **Don't promise output you haven't produced.** If you say "here's a chart", you must have just called \`make_chart\`. Save the prose for after the tool succeeds.
- **Don't repeat the data.** The client renders SQL results as a table and chart values are in the chart. Comment on what they mean — don't list the numbers.
- **Empty results → silently widen.** If a query returns 0 rows for the requested period, retry with a wider range. Don't narrate the dead end.
- **Sparse data → ship anyway with a caveat.** If tables have very few rows (e.g. 1 row each, suggesting an incomplete sync), still produce the requested chart or dashboard from what's there, then explain the sparsity in your reply ("your data looks light — only 1 order so far; this dashboard will fill in as more data syncs").
- **When ambiguous, ask.** If the user's question could mean two different things ("revenue" could be gross or net, "this month" could be calendar or fiscal), pick the most likely interpretation, produce the answer, and ask one clarifying question in your reply.
- **Answer only what was asked.** No "while we're here, also check…" tangents — each unrequested query is a billable scan.

## Multi-source

Each connector lives in its own dataset. \`list_tables\` groups by connector. If the user asks about "their data" without specifying source, query the most relevant source per the descriptions; mention the source you chose so they can redirect you.

## Follow-up offers

After completing the customer's request (chart / dashboard / answer), end with ONE short, specific follow-up offer — a single sentence, not a menu. Concrete examples beat generic ones:

- **After a dashboard**: *"Want me to add a daily sessions chart or filter this to last 30 days?"*
- **After a chart**: *"Want this broken down by channel as well?"*
- **After a data answer**: *"Want me to look at the same numbers for last month for comparison?"*

The offer should reference something visible in the data you just used. Don't write "let me know if you want anything else" — that's not specific enough to be useful. Skip the offer entirely if the conversation feels naturally complete (e.g. the customer said "thanks").

## Dates

Use the current date for relative references ("last quarter", "this month", "YTD"). Current date: ${new Date().toISOString().split("T")[0]}.`;

// Max agent turns per user message — prevents infinite tool loops.
// Sized for exec dashboards: `list_tables` (1) + 4-6 `run_sql` calls
// (one per chart) + `make_dashboard` (1) = 6-8 turns of actual work,
// plus retry headroom for queries that need widening or fixing.
//
// History: was 8 originally; bumped to 12 after seeing the agent run
// out mid-dashboard; bumped to 25 to give comfortable headroom even
// for heavy exec dashboards with 6+ charts and a few retry rounds.
// Cost per turn is dominated by Vertex (≈$0.003) + BQ scans (capped
// at 10GB / ~$0.05 per scan, but typical queries are far below).
// Worst-case 25-turn chat is ≈$0.10 — small per message, but the
// aggregate per-plan cap is the real cost guardrail (tracked
// separately in LIVELI-100: per-plan chat usage limits).
//
// The system prompt bans text-only turns (which previously burned
// budget for free), so most chats finish in well under the ceiling.
const MAX_TURNS = 25;

/**
 * Build the per-turn edit-context preamble that gets appended to
 * SYSTEM_PROMPT when the customer is editing an existing chart or
 * dashboard via chat. Tight prose + concrete instructions on which
 * update tool to call with which id. The current spec is embedded
 * verbatim so the model has a faithful starting point.
 *
 * Returns a string that drops onto the end of SYSTEM_PROMPT for this
 * turn only.
 */
export function buildEditContextPreamble(ec: {
  kind: "chart" | "dashboard";
  id: string;
  title: string;
  spec?: unknown;
  description?: string | null;
  charts?: Array<{ order?: number; title: string; spec?: unknown }>;
}): string {
  if (ec.kind === "chart") {
    return [
      `─── EDIT MODE ───`,
      `You are editing an EXISTING saved chart. The user will describe changes; apply them by calling \`update_chart\` (NOT make_chart) with the same id.`,
      ``,
      `chartId: ${ec.id}`,
      `title: ${ec.title}`,
      `current spec:`,
      "```json",
      JSON.stringify(ec.spec ?? null),
      "```",
      ``,
      `Rules:`,
      `- ALWAYS call update_chart with chartId="${ec.id}" — never make_chart, never a different id.`,
      `- The spec you pass REPLACES the existing one — include every field that should be on the chart after the edit.`,
      `- Don't call list_tables / run_sql unless the edit actually needs different data; most edits (chart type swap, colour, title) re-use the existing spec.`,
    ].join("\n");
  }
  return [
    `─── EDIT MODE ───`,
    `You are editing an EXISTING saved dashboard. The user will describe changes; apply them by calling \`update_dashboard\` (NOT make_dashboard) with the same id.`,
    ``,
    `dashboardId: ${ec.id}`,
    `title: ${ec.title}`,
    `description: ${ec.description ?? "(none)"}`,
    `current charts (in order):`,
    "```json",
    JSON.stringify(ec.charts ?? [], null, 0),
    "```",
    ``,
    `Rules:`,
    `- ALWAYS call update_dashboard with dashboardId="${ec.id}".`,
    `- The \`charts\` array REPLACES the existing list. Include EVERY chart that should be on the dashboard after the edit — adds, removes, reorders, and edits all flow through this one call.`,
    `- Don't call list_tables / run_sql unless the edit actually needs different data.`,
  ].join("\n");
}

/**
 * Emit a single-line summary of an agent turn for production timing
 * visibility. We bias toward one line per turn rather than many fine-
 * grained logs because Vercel's runtime log MCP aggregates by request
 * row and truncates content — a compact JSON summary survives that
 * aggregation, individual sub-logs get hidden.
 *
 * Read the log when chats hang or feel slow: each turn's `totalMs`
 * shows whether budget is going to Vertex (`vertexCallMs` + `streamMs`),
 * tools (`toolsMs` + per-tool breakdown), or auth (`authMs`).
 */
function logTurnComplete(
  turn: number,
  turnStart: number,
  metrics: {
    authMs: number;
    vertexCallMs: number;
    streamMs: number;
    toolsMs: number;
    toolsExecuted: Array<{ name: string; ms: number; ok: boolean }>;
  },
  hasMoreTurns: boolean
): void {
  console.log("[agent] turn complete", {
    turn,
    totalMs: Date.now() - turnStart,
    authMs: metrics.authMs,
    vertexCallMs: metrics.vertexCallMs,
    streamMs: metrics.streamMs,
    toolsMs: metrics.toolsMs,
    toolsExecuted: metrics.toolsExecuted,
    hasMoreTurns,
  });
}

/**
 * Walk an Error's `.cause` chain (and the SDK's custom `.stackTrace`
 * alias) and produce a single readable string covering every layer.
 *
 * Why: @google-cloud/vertexai wraps fetch failures twice. The outer
 * wrap message is just "exception posting request" — the URL lives
 * one layer down, our patch's body content lives two layers down.
 * `err.message` alone reveals none of that. This walker surfaces all
 * layers in one string the SSE error event can carry to the UI.
 *
 * Each layer is capped at 400 chars; Bearer tokens are redacted so
 * the request's JSONified Authorization header doesn't leak to the
 * browser via the error message.
 */
function flattenErrorChain(e: unknown, maxDepth = 8): string {
  const parts: string[] = [];
  let cur: unknown = e;
  let depth = 0;
  while (cur && depth < maxDepth) {
    if (cur instanceof Error) {
      let msg = cur.message ?? "";
      msg = msg.replace(/Bearer\s+[A-Za-z0-9._\-]+/g, "Bearer [redacted]");
      if (msg.length > 400) msg = msg.slice(0, 400) + "…";
      parts.push(`[${cur.name}] ${msg}`);
      const next = cur as Error & { cause?: unknown; stackTrace?: unknown };
      const candidate = next.cause ?? next.stackTrace;
      if (!candidate || candidate === cur) break;
      cur = candidate;
    } else {
      let s = String(cur);
      if (s.length > 400) s = s.slice(0, 400) + "…";
      parts.push(s);
      break;
    }
    depth++;
  }
  return parts.join(" ↳ ");
}

/**
 * Edit-context payload. When the user clicked Edit on a chart or
 * dashboard, the client carries this through every chat-API call for
 * the session. We use it to:
 *   1. Inject an "you are editing X with spec Y" preamble into the
 *      system prompt for this turn only (NOT persisted to history),
 *      so the model knows to call update_chart / update_dashboard
 *      with the provided id, instead of make_chart / make_dashboard.
 *   2. Keep working with the chart across multiple user messages
 *      ("change to bar" → "now make the bars green") without
 *      re-injecting from the user side every time.
 */
export interface AgentEditContext {
  kind: "chart" | "dashboard";
  id: string;
  title: string;
  spec?: unknown;
  description?: string | null;
  charts?: Array<{ order?: number; title: string; spec?: unknown }>;
}

export interface AgentTurnInput {
  clientId: string;
  workspaceId: string;
  userId: string;
  chatId?: string;
  userMessage: string;
  editContext?: AgentEditContext;
}

/**
 * Run one full agent turn against Gemini. Streams text deltas to the
 * client, dispatches function calls server-side, appends their results
 * to the conversation, loops until Gemini stops calling functions.
 *
 * Persists user + assistant messages to Firestore at
 *   clients/{clientId}/workspaces/{workspaceId}/chats/{chatId}/messages
 *
 * Gemini's streaming differs from Anthropic's in two important ways:
 *  1. No content-block boundaries — chunks contain Parts which can be
 *     text or functionCall. Text streams in deltas; functionCalls
 *     arrive whole (args don't split across chunks).
 *  2. The chat history is sent fresh on every turn (no SDK-managed
 *     state) — we maintain it ourselves in `history` and re-send.
 */
export async function* runAgentTurn(
  input: AgentTurnInput
): AsyncGenerator<ChatStreamEvent> {
  await ensureGcpAuth();

  // ── Resolve workspace residency → Vertex region ─────────────────
  // The workspace owns the data-residency choice; the agent's
  // inference region must match so we don't leak EU customer data
  // to US inference endpoints (or vice versa). bqLocation is the
  // single source of truth — set at workspace creation, immutable.
  await dbReady();
  const wsSnap = await workspaceDoc(input.clientId, input.workspaceId).get();
  const wsData = wsSnap.data() as { bqLocation?: "EU" | "US" } | undefined;
  const vertexRegion = vertexRegionForResidency(wsData?.bqLocation);

  // ── Open or create the chat ────────────────────────────────────
  const chatsCol = chatsIn(input.clientId, input.workspaceId);
  const chatRef = input.chatId ? chatsCol.doc(input.chatId) : chatsCol.doc();

  const isNewChat = !input.chatId;
  if (isNewChat) {
    await chatRef.set({
      createdBy: input.userId,
      createdAt: FieldValue.serverTimestamp(),
      title: input.userMessage.slice(0, 80),
    });
  }

  const chatId = chatRef.id;
  const messagesCol = messagesIn(input.clientId, input.workspaceId, chatId);

  // Append user message
  const userMsgRef = messagesCol.doc();
  await userMsgRef.set({
    role: "user",
    content: input.userMessage,
    createdAt: FieldValue.serverTimestamp(),
  });

  // ── Load conversation history (up to last 40 messages) ─────────
  const historySnap = await messagesCol
    .orderBy("createdAt", "asc")
    .limit(40)
    .get();

  type MsgContent =
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
    | { type: "tool_result"; tool_use_id: string; content: unknown };

  const history: Content[] = [];

  for (const doc of historySnap.docs) {
    const data = doc.data() as {
      role: "user" | "assistant";
      content: string;
      toolBlocks?: MsgContent[];
    };
    // Gemini uses role: "user" | "model" (not "assistant").
    const role = data.role === "assistant" ? "model" : "user";
    if (data.toolBlocks && data.toolBlocks.length > 0) {
      // CRITICAL: don't merge into one Content. Gemini rejects a Content
      // turn that mixes functionCall and functionResponse parts with:
      //   "function call turn contains at least one function_call part
      //    which can not be mixed with function_response"
      // tool_result parts must live on a {role: "user"} turn, separate
      // from any preceding text/tool_use on the assistant's {role: "model"}
      // turn. Split the flat block list back into alternating turns.
      history.push(...blocksToGeminiTurns(data.toolBlocks));
    } else {
      history.push({ role, parts: [{ text: data.content }] });
    }
  }

  // ── Announce chat to client ────────────────────────────────────
  const assistantMsgRef = messagesCol.doc();
  yield { type: "message_start", chatId, messageId: assistantMsgRef.id };

  const ctx: AgentContext = {
    clientId: input.clientId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    chatId,
    // Deprecated alias retained until all tools migrate off orgId.
    orgId: input.clientId,
  };

  // ── Model routing (mirrors the Claude path's classifier) ───────
  //
  // VERTEX_AI_MODEL_LIGHT acts as the opt-in for "simple → cheap"
  // routing. When set, queries classified as "simple" route to the
  // light model; everything else uses gcp.vertexModel as the primary.
  // When unset, routing is disabled and the primary handles all
  // traffic — safe default.
  //
  // Same heuristic as the Claude path (src/lib/agent-claude.ts):
  // edit context → complex, analytics trigger words → complex,
  // long messages (>200 chars) → complex, everything else simple.
  const COMPLEXITY_TRIGGERS = [
    "dashboard", "overview", "report", "summary", "breakdown", "trend",
    "compare", "comparison", "year over year", "month over month", "vs ",
    "versus", "build me", "compose", "analyze", "analyse",
  ];
  const classifyComplexity = (): "simple" | "complex" => {
    if (input.editContext) return "complex";
    const msg = input.userMessage.toLowerCase();
    if (COMPLEXITY_TRIGGERS.some((t) => msg.includes(t))) return "complex";
    if (input.userMessage.length > 200) return "complex";
    return "simple";
  };
  const complexity = classifyComplexity();
  const lightModel = gcp.vertexModelLight;
  const routedToLight = Boolean(lightModel && complexity === "simple");
  const routedModelId = routedToLight ? (lightModel as string) : gcp.vertexModel;
  console.log("[agent] model routing", {
    primary: gcp.vertexModel,
    light: lightModel ?? null,
    chosen: routedModelId,
    complexity,
    routedToLight,
  });

  const assistantText: string[] = [];
  const finalToolBlocks: MsgContent[] = [];
  const turnStartedAt = Date.now();
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let usageLogged = false;

  // Ensure usage is logged EXACTLY ONCE, regardless of how this generator
  // ends — normal completion, exception, or client-side cancellation
  // (e.g. user closes tab / aborts fetch). Without this guarantee we
  // silently lose token costs that the customer should be billed for.
  const flushUsage = () => {
    if (usageLogged) return;
    usageLogged = true;
    logAgentMessage({
      clientId: input.clientId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      chatId,
      // Log the ACTUAL model used (might be light or primary), so cost
      // analytics in usage_events segments cleanly by Flash vs Pro.
      model: routedModelId,
      tokensIn: totalTokensIn,
      tokensOut: totalTokensOut,
      executionMs: Date.now() - turnStartedAt,
    });
  };

  try {

  // ── Agentic loop ────────────────────────────────────────────────
  // Cap on how many times we'll inject a continuation prompt after the
  // model produces a text-only turn mid-workflow. See the handler at
  // the bottom of each loop iteration for context. Prevents an infinite
  // back-and-forth if the model is stuck and refuses to call tools.
  const MAX_TEXT_ONLY_CONTINUATIONS = 3;
  let textOnlyContinuations = 0;
  let turn = 0;
  while (turn < MAX_TURNS) {
    turn++;

    // Per-turn timing — surfaced as one compact log line at end of
    // each iteration so we can see where the 60s budget goes when a
    // chat hangs. Vercel runtime log MCP truncates content but
    // preserves whole-line JSON, so one summary line per turn is the
    // most useful shape.
    const turnStart = Date.now();
    const turnMetrics = {
      authMs: 0,
      vertexCallMs: 0,
      streamMs: 0,
      toolsMs: 0,
      toolsExecuted: [] as Array<{ name: string; ms: number; ok: boolean }>,
    };

    // Wrap each external call with tagged try/catch so failures
    // surface their actual source.
    const authStart = Date.now();
    try {
      await vertexReady(vertexRegion); // ensures ADC is written before the SDK reads it
    } catch (err) {
      const wrapped = new Error(
        `vertexReady failed (auth/ADC): ${err instanceof Error ? err.message : String(err)}`
      );
      (wrapped as Error & { source?: string }).source = "vertexReady";
      throw wrapped;
    }
    turnMetrics.authMs = Date.now() - authStart;

    // Build a fresh model per turn — systemInstruction lives here (not on
    // the per-request body) so the SDK uses its canonical wiring.
    //
    // When the customer is editing a chart/dashboard via chat, append a
    // tight edit-context preamble to the system prompt so the model
    // calls update_chart / update_dashboard with the right id instead
    // of make_chart / make_dashboard. This is NOT persisted to history
    // — it's per-turn context, derived from the editContext that the
    // client sends with every chat-API call in the edit session.
    const fnDecls = geminiFunctionDeclarations();
    const systemPromptText = input.editContext
      ? `${SYSTEM_PROMPT}\n\n${buildEditContextPreamble(input.editContext)}`
      : SYSTEM_PROMPT;
    const model = buildModel(
      vertexRegion,
      {
        systemInstruction: { role: "system", parts: [{ text: systemPromptText }] },
        tools: [{ functionDeclarations: fnDecls }],
      },
      routedModelId,
    );

    let result;
    const vertexCallStart = Date.now();
    try {
      console.log("[agent] generateContentStream", {
        region: vertexRegion,
        bqLocation: wsData?.bqLocation,
        model: gcp.vertexModel,
        project: gcp.projectId,
        turn,
        historyLen: history.length,
        fnDeclsCount: fnDecls.length,
        fnDeclsNames: fnDecls.map((f) => f.name),
      });
      result = await model.generateContentStream({
        contents: history,
        generationConfig: { maxOutputTokens: 4096 },
      });
      turnMetrics.vertexCallMs = Date.now() - vertexCallStart;
    } catch (err) {
      turnMetrics.vertexCallMs = Date.now() - vertexCallStart;
      const props: Record<string, unknown> = {};
      if (err && typeof err === "object") {
        for (const key of Object.getOwnPropertyNames(err)) {
          try {
            const v = (err as Record<string, unknown>)[key];
            if (typeof v !== "function") props[key] = v;
          } catch {
            /* unreadable */
          }
        }
      }
      const chain = flattenErrorChain(err);
      console.error("[agent] generateContentStream threw", {
        region: vertexRegion,
        model: gcp.vertexModel,
        project: gcp.projectId,
        name: err instanceof Error ? err.name : typeof err,
        message: err instanceof Error ? err.message : String(err),
        chain,
        stack: err instanceof Error ? err.stack : undefined,
        props,
      });
      const wrapped = new Error(
        `vertex.generateContentStream failed: ${chain}`
      );
      (wrapped as Error & { source?: string }).source = "vertex.generateContentStream";
      throw wrapped;
    }

    // Buffers for this turn — Gemini's streaming yields chunks with
    // candidates[].content.parts[]; functionCalls arrive in full, text
    // in deltas.
    const turnTextParts: string[] = [];
    const turnFunctionCalls: FunctionCall[] = [];

    // The stream iteration itself can throw a SyntaxError if the
    // underlying HTTP response is HTML (model not available in this
    // region, billing not enabled, auth challenged to web UI). Wrap
    // separately so the error tag identifies "stream iteration" not
    // "generateContentStream entry".
    let streamIter;
    try {
      streamIter = result.stream;
    } catch (err) {
      const wrapped = new Error(
        `vertex.stream access failed: ${err instanceof Error ? err.message : String(err)}`
      );
      (wrapped as Error & { source?: string }).source = "vertex.stream.access";
      throw wrapped;
    }

    const streamStart = Date.now();
    try {
      for await (const chunk of streamIter) {
        const candidate = chunk.candidates?.[0] as GenerateContentCandidate | undefined;
        const parts = candidate?.content?.parts;
        if (!parts) continue;

        for (const part of parts) {
          if (part.text) {
            yield { type: "text_delta", text: part.text };
            turnTextParts.push(part.text);
            assistantText.push(part.text);
          } else if (part.functionCall) {
            turnFunctionCalls.push(part.functionCall);
          }
        }

        // Token usage is on the last chunk's usageMetadata. We accumulate
        // — multiple iterations of the agentic loop each add to the total.
        const usage = chunk.usageMetadata;
        if (usage) {
          totalTokensIn += usage.promptTokenCount ?? 0;
          totalTokensOut += usage.candidatesTokenCount ?? 0;
        }
      }
      turnMetrics.streamMs = Date.now() - streamStart;
    } catch (err) {
      turnMetrics.streamMs = Date.now() - streamStart;
      const props: Record<string, unknown> = {};
      if (err && typeof err === "object") {
        for (const key of Object.getOwnPropertyNames(err)) {
          try {
            const v = (err as Record<string, unknown>)[key];
            if (typeof v !== "function") props[key] = v;
          } catch {
            /* unreadable */
          }
        }
      }
      const chain = flattenErrorChain(err);
      console.error("[agent] stream iteration threw", {
        region: vertexRegion,
        model: gcp.vertexModel,
        project: gcp.projectId,
        name: err instanceof Error ? err.name : typeof err,
        message: err instanceof Error ? err.message : String(err),
        chain,
        stack: err instanceof Error ? err.stack : undefined,
        props,
      });
      const wrapped = new Error(
        `vertex stream iteration failed: ${chain}`
      );
      (wrapped as Error & { source?: string }).source = "vertex.stream.iterate";
      throw wrapped;
    }

    // Persist this turn's content into history (so the next iteration
    // sees what the model just said).
    const turnParts: Part[] = [];
    if (turnTextParts.length > 0) {
      const text = turnTextParts.join("");
      turnParts.push({ text });
      finalToolBlocks.push({ type: "text", text });
    }
    for (const fc of turnFunctionCalls) {
      turnParts.push({ functionCall: fc });
    }
    if (turnParts.length > 0) {
      history.push({ role: "model", parts: turnParts });
    }

    // ── No function calls → check whether mid-workflow or genuinely done ──
    //
    // The naive interpretation ("text without tools = the agent's final
    // answer, break") is wrong for multi-step workflows. The model often
    // emits narration like "Here's the data:" or "First, let's gather…"
    // between tool calls. Breaking on those turns terminates the workflow
    // prematurely — the customer sees half-finished output and silence.
    //
    // The discriminator: was the IMMEDIATELY PRIOR history entry a tool
    // result? If yes → we're mid-workflow → inject a continuation prompt
    // and re-loop (capped at MAX_TEXT_ONLY_CONTINUATIONS). If no →
    // this is a legitimate conversational reply (e.g. user asked a yes/no
    // question that needed no tools) → break normally.
    //
    // Why this is server-side and not just a prompt rule: prose rules
    // ("don't narrate mid-workflow") are advisory. The model can still
    // emit text-only turns when confused. A server-side guard makes it
    // architecturally impossible to terminate mid-workflow regardless
    // of model behaviour.
    if (turnFunctionCalls.length === 0) {
      const prevEntry = history[history.length - 2];
      const prevWasToolResult =
        prevEntry?.role === "user" &&
        Array.isArray(prevEntry.parts) &&
        prevEntry.parts.some(
          (p: Part) => "functionResponse" in p && p.functionResponse !== undefined
        );

      if (prevWasToolResult && textOnlyContinuations < MAX_TEXT_ONLY_CONTINUATIONS) {
        textOnlyContinuations++;
        // Continuation prompt is appended as a "user" turn (Gemini's
        // convention — tool results are user-role, so are system
        // interventions). Phrased to give the model multiple escape
        // hatches so it can't get stuck.
        const continuationPrompt =
          "[System intervention] You produced reply text without calling a tool. " +
          "The workflow is incomplete — the customer is waiting for the final " +
          "output (chart / dashboard / table / summary). Do ONE of the following NOW:\n" +
          "  - If a chart was requested but not yet rendered: call make_chart.\n" +
          "  - If a dashboard was requested but not yet rendered: call make_dashboard.\n" +
          "  - If you are editing a chart/dashboard: call update_chart / update_dashboard.\n" +
          "  - If you need more data first: call run_sql.\n" +
          "  - If the workflow is genuinely complete: output your final summary in your next message AND ensure the user-facing tool (make_chart / make_dashboard / table from run_sql) has already been emitted.\n" +
          "Do NOT narrate further or repeat your previous text — call the appropriate tool now.";
        history.push({
          role: "user",
          parts: [{ text: continuationPrompt }],
        });
        console.warn("[agent] forced continuation after text-only mid-workflow turn", {
          turn,
          continuationsUsed: textOnlyContinuations,
          maxContinuations: MAX_TEXT_ONLY_CONTINUATIONS,
        });
        logTurnComplete(turn, turnStart, turnMetrics, true);
        continue;
      }

      // Either this is a legitimate conversational reply (no prior tool
      // results in this user message) OR continuation attempts are
      // exhausted. Either way, exit the loop. If exhausted, the
      // MAX_TURNS-style truncation message below the loop fires too.
      if (prevWasToolResult) {
        console.warn(
          "[agent] gave up forcing continuation; surfacing partial output",
          {
            turn,
            continuationsUsed: textOnlyContinuations,
          }
        );
      }
      logTurnComplete(turn, turnStart, turnMetrics, false);
      break;
    }

    // ── Execute the function calls ──────────────────────────────
    const fnResultParts: Part[] = [];

    for (const fc of turnFunctionCalls) {
      // Synthesize a tool_use ID — Gemini doesn't issue one but our
      // client UI needs a stable handle to associate the result later.
      const toolUseId = `tu_${Math.random().toString(36).slice(2, 14)}`;
      const fnName = fc.name ?? "";
      const fnArgs = (fc.args ?? {}) as Record<string, unknown>;

      yield {
        type: "tool_use",
        id: toolUseId,
        name: fnName,
        input: fnArgs,
      };

      finalToolBlocks.push({
        type: "tool_use",
        id: toolUseId,
        name: fnName,
        input: fnArgs,
      });

      const toolStart = Date.now();
      let toolOk = true;
      try {
        const result = await executeTool(fnName, fnArgs, ctx);

        if (result.clientRender?.kind === "chart") {
          yield {
            type: "chart",
            id: toolUseId,
            title: result.clientRender.title ?? fnName,
            spec: result.clientRender.spec,
          };
        } else if (result.clientRender?.kind === "table") {
          yield { type: "table", id: toolUseId, rows: result.clientRender.rows };
        } else if (result.clientRender?.kind === "dashboard") {
          yield {
            type: "dashboard",
            id: toolUseId,
            dashboardId: result.clientRender.dashboardId,
            title: result.clientRender.title,
            description: result.clientRender.description,
            charts: result.clientRender.charts,
          };
        } else if (result.clientRender?.kind === "insight-proposals") {
          yield {
            type: "insight-proposals",
            id: toolUseId,
            proposals: result.clientRender.proposals,
          };
        }

        yield { type: "tool_result", id: toolUseId, output: result.content };

        fnResultParts.push({
          functionResponse: {
            name: fnName,
            response: result.content as Record<string, unknown>,
          },
        });

        finalToolBlocks.push({
          type: "tool_result",
          tool_use_id: toolUseId,
          content: result.content,
        });
      } catch (err) {
        toolOk = false;
        const message = err instanceof Error ? err.message : String(err);
        yield { type: "tool_result", id: toolUseId, output: null, error: message };
        fnResultParts.push({
          functionResponse: {
            name: fnName,
            response: { error: message },
          },
        });
        finalToolBlocks.push({
          type: "tool_result",
          tool_use_id: toolUseId,
          content: { error: message },
        });
      }
      const toolMs = Date.now() - toolStart;
      turnMetrics.toolsMs += toolMs;
      turnMetrics.toolsExecuted.push({ name: fnName, ms: toolMs, ok: toolOk });
    }

    // Append all function responses as a single "user" turn (Gemini
    // semantics: tool outputs come from the user role, not assistant).
    history.push({ role: "user", parts: fnResultParts });

    logTurnComplete(turn, turnStart, turnMetrics, true);
  }

  // If we exited the loop because we hit MAX_TURNS (rather than because
  // the agent naturally stopped calling tools), the customer would
  // otherwise see whatever partial output the agent produced and then
  // silence. Surface a brief, voice-consistent message so they know to
  // try a smaller scope rather than wonder if the product hung.
  //
  // Also fires when the text-only-turn continuation handler exhausted
  // its retries (textOnlyContinuations >= cap) — same symptom from the
  // customer's POV (silent partial output), same recovery instruction.
  if (turn >= MAX_TURNS || textOnlyContinuations >= MAX_TEXT_ONLY_CONTINUATIONS) {
    const truncationMsg =
      "\n\nI ran out of steps before I could finish that. Try asking for a smaller scope (one chart at a time, or a narrower dashboard) and I'll have plenty of room.";
    assistantText.push(truncationMsg);
    yield { type: "text_delta", text: truncationMsg };
    console.warn("[agent] gave up before completion", {
      turns: turn,
      maxTurnsHit: turn >= MAX_TURNS,
      textOnlyContinuationsHit: textOnlyContinuations >= MAX_TEXT_ONLY_CONTINUATIONS,
    });
  }

  console.log("[agent] runAgentTurn complete", {
    turns: turn,
    totalMs: Date.now() - turnStartedAt,
    tokensIn: totalTokensIn,
    tokensOut: totalTokensOut,
  });

  yield { type: "message_stop" };

  // ── Persist the full assistant message ──────────────────────────
  // Stringify tool_use.input and tool_result.content before writing to
  // Firestore. Why: Firestore rejects documents containing array-of-array
  // values ("Property array contains an invalid nested entity"). Tool
  // inputs/outputs are model-generated payloads that can include
  // arbitrarily nested shapes (e.g. ECharts series.data was a 2D array
  // before we normalized it to flat numbers + xAxis labels, and the
  // failed-validation case still pushes the original tool_use to
  // toolBlocks). Stringifying the variable-shape fields makes the
  // persisted doc Firestore-safe regardless of what the model emitted.
  // blocksToGeminiTurns / msgContentToGeminiPart parse on replay.
  const persistableToolBlocks = finalToolBlocks.map((b) => {
    if (b.type === "tool_use") {
      return { ...b, input: JSON.stringify(b.input ?? null) };
    }
    if (b.type === "tool_result") {
      return { ...b, content: JSON.stringify(b.content ?? null) };
    }
    return b;
  });
  await assistantMsgRef.set({
    role: "assistant",
    content: assistantText.join(""),
    toolBlocks: persistableToolBlocks,
    createdAt: FieldValue.serverTimestamp(),
  });

  } finally {
    // Fires on normal completion, exception, AND client cancellation
    // (generator.return()). logAgentMessage is itself fire-and-forget so
    // this won't block the cancellation path. Idempotent via usageLogged.
    flushUsage();
  }
}

/**
 * Convert a persisted MsgContent (our internal Anthropic-flavored
 * shape) back into a Gemini Part for re-sending in history. We keep
 * the persisted format consistent across model swaps so old chats
 * remain replayable.
 */
function msgContentToGeminiPart(
  block:
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
    | { type: "tool_result"; tool_use_id: string; content: unknown }
): Part {
  if (block.type === "text") return { text: block.text };
  if (block.type === "tool_use") {
    return { functionCall: { name: block.name, args: unwrapJsonField(block.input) } };
  }
  // tool_result — Gemini wraps as functionResponse, no tool_use_id in
  // its shape, we just pass the content.
  return {
    functionResponse: {
      name: "tool_result",
      response: unwrapJsonField(block.content),
    },
  };
}

/**
 * Persisted toolBlocks may have `input`/`content` either as raw objects
 * (legacy / in-memory) or as JSON strings (post-stringification at
 * persist time, see assistantMsgRef.set above). Accept both forms so
 * old chats remain replayable.
 */
function unwrapJsonField(v: unknown): Record<string, unknown> {
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return {};
}

/**
 * Split a persisted assistant message's flat block list back into the
 * Content turns Gemini's API expects.
 *
 * Why this matters: during a single runAgentTurn we build history in
 * the correct shape (model turn → user turn for tool_results → model
 * turn → …). But we persist the entire assistant exchange as ONE
 * Firestore doc with `toolBlocks` holding all parts in order. Replaying
 * that as a single Content turn merges function_call and function_response
 * parts, which Gemini rejects with:
 *
 *   "function call turn contains at least one function_call part which
 *    can not be mixed with function_response"
 *
 * We detect role boundaries by part kind:
 *   - text + tool_use  →  {role: "model"} turn
 *   - tool_result      →  {role: "user"} turn (Gemini puts tool outputs
 *                          on the user role, not assistant)
 * and emit a new Content each time the role changes.
 */
function blocksToGeminiTurns(
  blocks: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
    | { type: "tool_result"; tool_use_id: string; content: unknown }
  >
): Content[] {
  const turns: Content[] = [];
  let currentRole: "model" | "user" | null = null;
  let currentParts: Part[] = [];

  for (const block of blocks) {
    const targetRole: "model" | "user" =
      block.type === "tool_result" ? "user" : "model";
    if (currentRole !== null && currentRole !== targetRole) {
      turns.push({ role: currentRole, parts: currentParts });
      currentParts = [];
    }
    currentRole = targetRole;
    currentParts.push(msgContentToGeminiPart(block));
  }
  if (currentRole !== null && currentParts.length > 0) {
    turns.push({ role: currentRole, parts: currentParts });
  }
  return turns;
}
