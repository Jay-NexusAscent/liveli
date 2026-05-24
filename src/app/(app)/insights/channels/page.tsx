"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowRightIcon,
  CheckIcon,
  CloseIcon,
  InsightIcon,
  PlusIcon,
  TrashIcon,
} from "@/components/icons";
import type {
  AlertChannelPublic,
  AlertChannelType,
} from "@/lib/insights/notify";

/**
 * Channel-type picker order. Slack first because it's the most-
 * requested SaaS channel; Webhook last because it's the catch-all
 * power-user option.
 */
const CHANNEL_TYPES: { type: AlertChannelType; label: string; hint: string }[] = [
  { type: "slack", label: "Slack", hint: "Incoming webhook from a Slack workspace" },
  { type: "teams", label: "Microsoft Teams", hint: "Incoming webhook from a Teams channel" },
  { type: "telegram", label: "Telegram", hint: "Bot token + chat ID via @BotFather" },
  { type: "webhook", label: "Generic webhook", hint: "JSON POST to any HTTPS URL" },
];

type TestState =
  | { status: "idle" }
  | { status: "sending" }
  | { status: "sent" }
  | { status: "failed"; message: string };

export default function InsightsChannelsPage() {
  const [channels, setChannels] = useState<AlertChannelPublic[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [testStates, setTestStates] = useState<Record<string, TestState>>({});
  const [toggling, setToggling] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState<Set<string>>(new Set());

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/insights/channels");
        if (res.ok) {
          const items: AlertChannelPublic[] = (await res.json()).items ?? [];
          setChannels(items);
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  /**
   * Drop a freshly-created channel into local state without a full
   * refetch — the POST response includes the redacted public view
   * already.
   */
  const onCreated = (channel: AlertChannelPublic) => {
    setChannels((items) => [channel, ...items]);
    setAddOpen(false);
  };

  /**
   * Toggle the channel's `enabled` flag. Optimistic — flip immediately;
   * roll back if the PATCH fails.
   */
  const toggleEnabled = async (channel: AlertChannelPublic) => {
    setToggling((s) => new Set(s).add(channel.id));
    const next = !channel.enabled;
    setChannels((items) =>
      items.map((c) => (c.id === channel.id ? { ...c, enabled: next } : c))
    );
    try {
      const res = await fetch(`/api/insights/channels/${channel.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      setChannels((items) =>
        items.map((c) =>
          c.id === channel.id ? { ...c, enabled: channel.enabled } : c
        )
      );
      alert(`Couldn't toggle: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setToggling((s) => {
        const next = new Set(s);
        next.delete(channel.id);
        return next;
      });
    }
  };

  /**
   * Fire a test send. The endpoint returns 200 with ok:false on
   * provider-side failures (bad webhook URL, expired token, etc.) —
   * we show those inline as a 5s banner above the card so customers
   * can fix the channel without leaving the page.
   */
  const sendTest = async (channel: AlertChannelPublic) => {
    setTestStates((m) => ({ ...m, [channel.id]: { status: "sending" } }));
    try {
      const res = await fetch(`/api/insights/channels/${channel.id}/test`, {
        method: "POST",
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || payload.ok === false) {
        setTestStates((m) => ({
          ...m,
          [channel.id]: {
            status: "failed",
            message: payload?.error ?? `HTTP ${res.status}`,
          },
        }));
      } else {
        setTestStates((m) => ({ ...m, [channel.id]: { status: "sent" } }));
        // Refetch channels to pick up the updated lastSentAt/lastSendError.
        const list = await fetch("/api/insights/channels");
        if (list.ok) setChannels((await list.json()).items ?? channels);
      }
    } catch (err) {
      setTestStates((m) => ({
        ...m,
        [channel.id]: {
          status: "failed",
          message: err instanceof Error ? err.message : String(err),
        },
      }));
    }
    // Clear test status after 5s so the banner auto-dismisses.
    setTimeout(() => {
      setTestStates((m) => {
        const { [channel.id]: _, ...rest } = m;
        void _;
        return rest;
      });
    }, 5000);
  };

  const removeChannel = async (channel: AlertChannelPublic) => {
    if (!confirm(`Delete channel "${channel.name}"? Real alerts will stop being sent here.`)) {
      return;
    }
    setDeleting((s) => new Set(s).add(channel.id));
    try {
      const res = await fetch(`/api/insights/channels/${channel.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setChannels((items) => items.filter((c) => c.id !== channel.id));
    } catch (err) {
      alert(`Couldn't delete: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDeleting((s) => {
        const next = new Set(s);
        next.delete(channel.id);
        return next;
      });
    }
  };

  return (
    <div className="container-page py-8">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <Link
            href="/insights"
            className="mb-2 inline-flex items-center gap-1 text-[12px] text-text-tertiary transition-colors hover:text-text-primary"
          >
            <ArrowRightIcon className="h-3 w-3 rotate-180" />
            Back to Insights
          </Link>
          <h1 className="text-[28px] font-semibold tracking-tight text-text-primary font-heading">
            Alert channels
          </h1>
          <p className="mt-1 text-[14px] text-text-secondary">
            Wire up Slack, Teams, Telegram, or a generic webhook. Fired insights are pushed to every enabled channel.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-accent/90"
        >
          <PlusIcon />
          Add channel
        </button>
      </header>

      {loading && <p className="text-[13px] text-text-tertiary">Loading…</p>}

      {!loading && channels.length === 0 && (
        <div className="card-elevated flex flex-col items-center justify-center gap-3 py-20 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent-muted text-accent">
            <InsightIcon className="text-accent" />
          </div>
          <h2 className="text-[18px] font-semibold tracking-tight text-text-primary font-heading">
            No channels yet
          </h2>
          <p className="max-w-md text-[14px] text-text-secondary">
            Add a channel to start receiving alerts when your insights fire. You can wire up multiple channels — each fired alert goes to all of them.
          </p>
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-accent/90"
          >
            <PlusIcon />
            Add your first channel
          </button>
        </div>
      )}

      {channels.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {channels.map((channel) => {
            const testState = testStates[channel.id] ?? { status: "idle" as const };
            return (
              <ChannelCard
                key={channel.id}
                channel={channel}
                isToggling={toggling.has(channel.id)}
                isDeleting={deleting.has(channel.id)}
                testState={testState}
                onToggle={() => toggleEnabled(channel)}
                onTest={() => sendTest(channel)}
                onDelete={() => removeChannel(channel)}
              />
            );
          })}
        </div>
      )}

      {addOpen && (
        <AddChannelModal
          onClose={() => setAddOpen(false)}
          onCreated={onCreated}
        />
      )}
    </div>
  );
}

function ChannelCard({
  channel,
  isToggling,
  isDeleting,
  testState,
  onToggle,
  onTest,
  onDelete,
}: {
  channel: AlertChannelPublic;
  isToggling: boolean;
  isDeleting: boolean;
  testState: TestState;
  onToggle: () => void;
  onTest: () => void;
  onDelete: () => void;
}) {
  const typeLabel = CHANNEL_TYPES.find((t) => t.type === channel.type)?.label ?? channel.type;
  return (
    <article className="card-elevated flex flex-col gap-3 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-wider text-text-tertiary">
            {typeLabel}
          </p>
          <h3 className="mt-0.5 text-[16px] font-semibold text-text-primary font-heading">
            {channel.name}
          </h3>
        </div>
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
            channel.enabled
              ? "bg-[#10B981]/15 text-[#10B981]"
              : "bg-text-tertiary/15 text-text-tertiary"
          }`}
        >
          {channel.enabled ? "Enabled" : "Disabled"}
        </span>
      </div>

      <p className="break-all font-mono text-[11px] text-text-tertiary">
        {channel.configPreview}
      </p>

      {testState.status === "sent" && (
        <div className="rounded-md border border-[#10B981]/30 bg-[#10B981]/10 px-2.5 py-1.5 text-[12px] text-[#10B981]">
          Test sent — check the channel.
        </div>
      )}
      {testState.status === "failed" && (
        <div className="rounded-md border border-[color:var(--status-error)]/30 bg-[color:var(--status-error)]/10 px-2.5 py-1.5 text-[12px] text-[color:var(--status-error)]">
          Test failed: {testState.message}
        </div>
      )}
      {channel.lastSendError && testState.status === "idle" && (
        <div className="rounded-md border border-[color:var(--status-error)]/30 bg-[color:var(--status-error)]/10 px-2.5 py-1.5 text-[12px] text-[color:var(--status-error)]">
          Last send failed: {channel.lastSendError}
        </div>
      )}

      <div className="mt-auto flex items-center justify-between gap-2 border-t border-border pt-3">
        <button
          type="button"
          onClick={onTest}
          disabled={testState.status === "sending"}
          className="rounded-md px-2 py-1 text-[12px] text-text-secondary transition-colors hover:bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          {testState.status === "sending" ? "Sending…" : "Send test"}
        </button>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onToggle}
            disabled={isToggling}
            className="rounded-md px-2 py-1 text-[12px] text-text-secondary transition-colors hover:bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {channel.enabled ? "Disable" : "Enable"}
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={isDeleting}
            aria-label={`Delete channel ${channel.name}`}
            className="rounded-md p-1.5 text-text-tertiary transition-colors hover:bg-[color:var(--status-error)]/10 hover:text-[color:var(--status-error)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <TrashIcon />
          </button>
        </div>
      </div>
    </article>
  );
}

/**
 * Two-step modal: first pick the channel type (button grid), then
 * fill in the type-specific form. Picking is kept on a separate step
 * so the form fields stay focused — one type = one form.
 *
 * Submits to POST /api/insights/channels. On success, hands the
 * fresh AlertChannelPublic back via onCreated so the parent can
 * insert it without a refetch.
 */
function AddChannelModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (channel: AlertChannelPublic) => void;
}) {
  const [type, setType] = useState<AlertChannelType | null>(null);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="card-elevated max-h-[90vh] w-full max-w-md overflow-y-auto p-6">
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="text-[18px] font-semibold text-text-primary font-heading">
            {type === null ? "Add a channel" : `Configure ${typeLabel(type)}`}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-text-tertiary transition-colors hover:bg-hover hover:text-text-primary"
          >
            <CloseIcon />
          </button>
        </div>

        {type === null ? (
          <div className="space-y-2">
            {CHANNEL_TYPES.map((t) => (
              <button
                key={t.type}
                type="button"
                onClick={() => setType(t.type)}
                className="flex w-full items-center justify-between gap-3 rounded-lg border border-border bg-surface p-3 text-left transition-colors hover:border-accent hover:bg-hover"
              >
                <div>
                  <p className="text-[14px] font-medium text-text-primary">{t.label}</p>
                  <p className="text-[12px] text-text-secondary">{t.hint}</p>
                </div>
                <ArrowRightIcon className="text-text-tertiary" />
              </button>
            ))}
          </div>
        ) : (
          <ChannelForm
            type={type}
            onBack={() => setType(null)}
            onCreated={onCreated}
          />
        )}
      </div>
    </div>
  );
}

function typeLabel(type: AlertChannelType): string {
  return CHANNEL_TYPES.find((t) => t.type === type)?.label ?? type;
}

/**
 * Per-type form. Each channel needs different fields; rather than
 * one ballooning form with optional everything, we render the right
 * fields based on type. All paths POST to the same endpoint with
 * the type discriminator + type-specific fields.
 */
function ChannelForm({
  type,
  onBack,
  onCreated,
}: {
  type: AlertChannelType;
  onBack: () => void;
  onCreated: (channel: AlertChannelPublic) => void;
}) {
  const [name, setName] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [bearerSecret, setBearerSecret] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!name.trim()) {
      setError("Give this channel a name (e.g. 'Engineering Slack').");
      return;
    }
    setSubmitting(true);

    let body: Record<string, unknown>;
    switch (type) {
      case "slack":
      case "teams":
        if (!webhookUrl) {
          setError("Webhook URL is required.");
          setSubmitting(false);
          return;
        }
        body = { type, name, webhookUrl };
        break;
      case "telegram":
        if (!botToken || !chatId) {
          setError("Bot token and chat ID are both required.");
          setSubmitting(false);
          return;
        }
        body = { type, name, botToken, chatId };
        break;
      case "webhook":
        if (!webhookUrl) {
          setError("Webhook URL is required.");
          setSubmitting(false);
          return;
        }
        body = {
          type,
          name,
          webhookUrl,
          ...(bearerSecret ? { bearerSecret } : {}),
        };
        break;
    }

    try {
      const res = await fetch("/api/insights/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(payload?.error ?? `HTTP ${res.status}`);
        return;
      }
      onCreated(payload.channel as AlertChannelPublic);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={onBack}
        className="text-[12px] text-text-tertiary transition-colors hover:text-text-primary"
      >
        ← Pick a different type
      </button>

      <Field label="Name">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Engineering Slack"
          className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-[13px] text-text-primary focus:border-accent focus:outline-none"
        />
      </Field>

      {(type === "slack" || type === "teams" || type === "webhook") && (
        <Field
          label="Webhook URL"
          hint={
            type === "slack"
              ? "Create an incoming webhook in your Slack workspace settings."
              : type === "teams"
                ? "Add a 'Workflows' or 'Incoming Webhook' connector to a Teams channel."
                : "Any HTTPS endpoint that accepts a JSON POST."
          }
        >
          <input
            type="url"
            value={webhookUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
            placeholder="https://hooks.slack.com/services/…"
            className="w-full rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-[12px] text-text-primary focus:border-accent focus:outline-none"
          />
        </Field>
      )}

      {type === "webhook" && (
        <Field
          label="Bearer secret (optional)"
          hint="Sent as Authorization: Bearer <secret>. Leave blank for no auth."
        >
          <input
            type="password"
            value={bearerSecret}
            onChange={(e) => setBearerSecret(e.target.value)}
            placeholder="(none)"
            className="w-full rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-[12px] text-text-primary focus:border-accent focus:outline-none"
          />
        </Field>
      )}

      {type === "telegram" && (
        <>
          <Field
            label="Bot token"
            hint="From @BotFather (use /newbot then copy the token)."
          >
            <input
              type="password"
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              placeholder="123456:ABC-…"
              className="w-full rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-[12px] text-text-primary focus:border-accent focus:outline-none"
            />
          </Field>
          <Field
            label="Chat ID"
            hint="Forward a message to @RawDataBot to find your chat ID."
          >
            <input
              type="text"
              value={chatId}
              onChange={(e) => setChatId(e.target.value)}
              placeholder="-1001234567890"
              className="w-full rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-[12px] text-text-primary focus:border-accent focus:outline-none"
            />
          </Field>
        </>
      )}

      {error && (
        <div className="rounded-md border border-[color:var(--status-error)]/30 bg-[color:var(--status-error)]/10 px-2.5 py-1.5 text-[12px] text-[color:var(--status-error)]">
          {error}
        </div>
      )}

      <button
        type="button"
        onClick={submit}
        disabled={submitting}
        className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-accent px-3 py-2 text-[13px] font-medium text-white transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? "Saving…" : <><CheckIcon /> Save channel</>}
      </button>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] font-medium text-text-secondary">
        {label}
      </span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-text-tertiary">{hint}</span>}
    </label>
  );
}
