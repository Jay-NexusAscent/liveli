import { SparkleIcon } from "@/components/icons";

export default function ChatPage() {
  // Placeholder full-window chat surface. Real wiring lands when Vertex AI is hooked up.
  return (
    <div className="flex h-[calc(100vh-56px)] flex-col lg:h-screen">
      {/* Scrollable message area */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex h-full max-w-3xl flex-col items-center justify-center px-6 text-center">
          <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-muted text-accent">
            <SparkleIcon className="h-7 w-7" />
          </div>
          <h1 className="text-[32px] font-semibold tracking-tight text-text-primary font-heading">
            Ask anything about your data.
          </h1>
          <p className="mt-3 max-w-md text-[15px] text-text-secondary">
            Connect a data source first, then ask the agent — it&apos;ll write the SQL,
            run it, and explain the answer with a chart.
          </p>

          <div className="mt-8 grid w-full max-w-xl grid-cols-1 gap-3 sm:grid-cols-2">
            {[
              "What were our top 5 products by revenue last quarter?",
              "Show me weekly active users over the last 90 days",
              "Which channels drive the highest LTV customers?",
              "Compare this month's churn vs last month",
            ].map((prompt) => (
              <button
                key={prompt}
                type="button"
                className="card cursor-pointer p-3 text-left text-[13px] text-text-secondary transition-colors hover:text-text-primary"
              >
                {prompt}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Composer */}
      <div className="border-t border-border bg-elevated">
        <div className="mx-auto max-w-3xl px-6 py-4">
          <div className="card flex items-center gap-3 p-3">
            <input
              type="text"
              placeholder="Ask a question or describe a chart…"
              className="flex-1 bg-transparent text-[15px] text-text-primary placeholder:text-text-tertiary focus:outline-none"
            />
            <button
              type="button"
              disabled
              className="rounded-md bg-accent px-4 py-1.5 text-[13px] font-medium text-text-inverted opacity-60"
              title="Coming soon — agent not yet wired"
            >
              Send
            </button>
          </div>
          <p className="mt-2 text-center text-[11px] text-text-tertiary">
            Agent comes online once Vertex AI is wired. Until then, this is a UI preview.
          </p>
        </div>
      </div>
    </div>
  );
}
