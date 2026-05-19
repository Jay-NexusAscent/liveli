"use client";

import { useRouter } from "next/navigation";
import {
  InsightIcon,
  SparkleIcon,
  TrendUpIcon,
  TrendDownIcon,
  ArrowRightIcon,
} from "@/components/icons";

const PREFILL_STORAGE_KEY = "liveli.chatPrefill";

/**
 * Mocked insights for the Phase-1 UI scaffold. The actual generation
 * agent is tracked in LIVELI-91 — when it ships, this static list is
 * replaced by a Firestore-backed feed keyed by clientId/workspaceId.
 *
 * Each `prefill` is the natural question that opens this insight in
 * the chat for deeper exploration. Clicking "Query further" stashes
 * the prompt in sessionStorage under PREFILL_STORAGE_KEY and routes
 * to /chat, where ChatWindow reads it on mount and pre-fills the
 * input (then clears it on send).
 */
type Trend = "up" | "down" | "flat";
type Category = "Sales" | "Customer" | "Operational" | "Growth";

interface MockInsight {
  id: string;
  category: Category;
  title: string;
  description: string;
  metric?: string;
  trend?: Trend;
  source: string;
  freshness: string;
  isNew?: boolean;
  prefill: string;
}

const MOCK_INSIGHTS: MockInsight[] = [
  {
    id: "i1",
    category: "Sales",
    title: "Average order value up 8% this week",
    description:
      "AOV climbed from £42.10 to £45.50 over the last 7 days, driven by larger basket sizes on Tuesdays and Wednesdays.",
    metric: "+8%",
    trend: "up",
    source: "Postgres Demo",
    freshness: "2h ago",
    isNew: true,
    prefill:
      "Break down the 8% AOV increase this week — which product categories drove it, and which days saw the biggest lift?",
  },
  {
    id: "i2",
    category: "Sales",
    title: "Revenue down 12% week-over-week",
    description:
      "Total revenue dropped from £18.4k to £16.2k. The decline is concentrated in returning customers, not new acquisitions.",
    metric: "−12%",
    trend: "down",
    source: "Postgres Demo",
    freshness: "2h ago",
    isNew: true,
    prefill:
      "Investigate the 12% revenue drop — show me which customer cohorts contributed most, broken down by country and product category.",
  },
  {
    id: "i3",
    category: "Customer",
    title: "5 high-value customers haven't ordered in 30 days",
    description:
      "Five customers in the top revenue decile haven't placed an order since 2026-04-19. Worth a re-engagement nudge.",
    source: "Postgres Demo",
    freshness: "5h ago",
    prefill:
      "Show me the 5 high-value customers who haven't ordered in 30 days, including their previous order history and average order value.",
  },
  {
    id: "i4",
    category: "Growth",
    title: "New customer cohort emerging from Spain",
    description:
      "Spanish signups up 4× in the last 14 days vs. the prior 14. None of these customers have placed a second order yet — early funnel.",
    metric: "4×",
    trend: "up",
    source: "Postgres Demo",
    freshness: "1d ago",
    prefill:
      "Tell me more about the Spanish customer cohort — when they signed up, what they've purchased, and how they compare to the German and French cohorts at the same stage.",
  },
  {
    id: "i5",
    category: "Sales",
    title: "Tuesday is your peak sales day",
    description:
      "Tuesdays consistently outperform other weekdays by 18% on average. Friday is the weakest, 22% below Tuesday.",
    metric: "+18%",
    trend: "up",
    source: "Postgres Demo",
    freshness: "1d ago",
    prefill:
      "Show me a chart of sales by day of week for the last 90 days, and highlight what makes Tuesdays different.",
  },
  {
    id: "i6",
    category: "Operational",
    title: "Postgres sync taking 4× longer this week",
    description:
      "Average sync time rose from 38s to 2m 32s. Likely a row-count or schema-change effect — worth checking before it impacts freshness.",
    metric: "4×",
    trend: "down",
    source: "Postgres Demo",
    freshness: "3h ago",
    prefill:
      "Why are my Postgres syncs taking longer this week? Show me sync durations and row counts over the last 30 days.",
  },
];

const CATEGORY_STYLES: Record<Category, string> = {
  Sales: "bg-accent-muted text-accent",
  Customer: "bg-[#10B981]/15 text-[#10B981]",
  Operational: "bg-[#F59E0B]/15 text-[#F59E0B]",
  Growth: "bg-[#8B5CF6]/15 text-[#8B5CF6]",
};

function TrendBadge({ trend, metric }: { trend?: Trend; metric?: string }) {
  if (!metric) return null;
  const isUp = trend === "up";
  const isDown = trend === "down";
  const color = isUp
    ? "text-[#10B981]"
    : isDown
      ? "text-[#EF4444]"
      : "text-text-tertiary";
  return (
    <div className={`flex items-center gap-1 text-[13px] font-mono tabular-nums ${color}`}>
      {isUp && <TrendUpIcon />}
      {isDown && <TrendDownIcon />}
      <span>{metric}</span>
    </div>
  );
}

export default function InsightsPage() {
  const router = useRouter();

  const openInChat = (prefill: string) => {
    sessionStorage.setItem(PREFILL_STORAGE_KEY, prefill);
    router.push("/chat");
  };

  return (
    <div className="container-page py-8">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-semibold tracking-tight text-text-primary font-heading">
            Insights
          </h1>
          <p className="mt-1 text-[14px] text-text-secondary">
            Findings the agent has surfaced from your data. Click&nbsp;
            <span className="text-text-primary">Query further</span> on any
            insight to open it in chat and dig deeper.
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-md border border-border bg-elevated px-3 py-1.5 text-[12px] text-text-tertiary">
          <SparkleIcon className="text-accent" />
          <span>Preview — agent generation pending</span>
        </div>
      </header>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {MOCK_INSIGHTS.map((insight) => (
          <article
            key={insight.id}
            className="card-elevated flex flex-col gap-4 p-5"
          >
            <div className="flex items-center justify-between gap-3">
              <span
                className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wider ${CATEGORY_STYLES[insight.category]}`}
              >
                {insight.category}
              </span>
              <div className="flex items-center gap-2">
                {insight.isNew && (
                  <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white">
                    New
                  </span>
                )}
                <span className="text-[12px] text-text-tertiary">
                  {insight.freshness}
                </span>
              </div>
            </div>

            <div className="flex items-start justify-between gap-3">
              <h2 className="text-[16px] font-semibold leading-snug tracking-tight text-text-primary font-heading">
                {insight.title}
              </h2>
              <TrendBadge trend={insight.trend} metric={insight.metric} />
            </div>

            <p className="text-[13px] leading-relaxed text-text-secondary">
              {insight.description}
            </p>

            <div className="mt-auto flex items-center justify-between gap-3 border-t border-border pt-3">
              <span className="flex items-center gap-1.5 text-[12px] text-text-tertiary">
                <InsightIcon className="opacity-60" />
                <span>{insight.source}</span>
              </span>
              <button
                type="button"
                onClick={() => openInChat(insight.prefill)}
                className="inline-flex items-center gap-1.5 rounded-md bg-accent-muted px-3 py-1.5 text-[12px] font-medium text-accent transition-colors hover:bg-accent hover:text-white"
              >
                Query further
                <ArrowRightIcon className="h-3 w-3" />
              </button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
