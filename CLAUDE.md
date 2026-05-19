# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

**Liveli** — an AI data-analytics product. Users connect data sources (Meltano, 600+ taps), Liveli ingests into BigQuery, and an AI agent (Claude via Vertex AI) answers natural-language questions and builds dashboards.

## Architecture

**One Next.js app, two domains:**
- `liveli.co.uk` → route group `(marketing)` — public landing
- `app.liveli.co.uk` → route group `(app)` — auth-walled product
- Subdomain split happens in [middleware.ts](middleware.ts) via the `Host` header

**Route groups:**
- `src/app/(marketing)/*` — public, no sidebar
- `src/app/(auth)/*` — Clerk sign-in/up
- `src/app/(app)/*` — authenticated, sidebar layout, three tabs: Chat / Connections / Dashboards

**GCP project:** `liveli-496609`. Regions split:
- **Vertex AI** → `global` endpoint by default (dynamic routing, no premium). Use `eu` multi-region for EU-residency tier (10% premium), or `europe-west1` for provisioned throughput. Older Vertex docs referred to `us-central1` as the only region with Opus 4.7 — that's outdated; `global`/`us`/`eu` all serve the current Claude family (Opus 4.7, Sonnet 4.6, Haiku 4.5).
- **Cloud Run / Artifact Registry / Secret Manager** → `europe-west4`
- **BigQuery / GCS** → `EU` multi-region (workspace datasets currently US — being migrated, see LIVELI-46)
- **Firestore** → `eur3` multi-region

For EU-residency workspaces, pin Vertex region to `eu` so inference also stays in EU. Otherwise the `global` endpoint dynamically routes for best availability.

**One-time Vertex AI setup** (already done for `liveli-496609`): each Claude model must be enabled in Vertex AI Model Garden per project — open the model card and click "Enable". Without this you get a 404 "Publisher Model not found or your project does not have access".

**Auth identity (local):** `james@nexusascent.co.uk`.

## Design system

- Tailwind 4 CSS-first config in `src/app/globals.css` — no `tailwind.config.ts`
- Indigo accent (`#818CF8` dark / `#6366F1` light)
- Dark default, light theme via `data-theme="light"` on `<html>`, persisted in `localStorage` under key `liveli-theme`
- Fonts: Space Grotesk (`font-heading`), DM Sans (`font-sans`), Geist Mono (`font-mono`)
- Glass cards: `.card` class with backdrop-filter blur and hover glow
- ECG heartbeat logo + animated hero line — brand motif shared with `liveli-web` and `liveli-portal`

When editing styles, use the design tokens (`bg-surface`, `text-text-secondary`, `text-accent`, `border-border`) not raw hex.

## Conventions

- Server components by default; `"use client"` only when interactive
- Path alias `@/*` → `./src/*`
- All shared icons in `src/components/icons.tsx` (heroicons-style, `currentColor`, 20×20)
- Numeric values in `tabular-nums` font-mono
- Multi-tenancy: every BigQuery query, Firestore read, and GCS access must be scoped by `orgId` from Clerk's `auth()`. Never trust client-supplied IDs.

## Linear

Issue prefix is **`LIVELI`** (Liveli team in Linear). Commits and PR titles must reference issues by this prefix — e.g. `LIVELI-12: wire chat to vertex`. Linear's GitHub integration auto-links commits and PRs to the referenced issue.

## Stage of build

Past the scaffold stage. Currently in private testing with the email allowlist on (LIVELI_ALLOWED_EMAILS env var). Major chunks shipped:

- **Marketing**: landing + 5-tier pricing section (LIVELI-69 tracks removing the allowlist for public launch)
- **Auth**: Clerk Organizations with eager provisioning via webhook + delete-account flow with billing-history preservation (LIVELI-75 tracks the 30-day soft-delete grace period)
- **Multi-tenancy**: Client → Workspace → Connector hierarchy in Firestore. Dataset-per-connector in BigQuery, naming `c_<C>__w_<W>__d_<conn>`
- **Connectors**: Postgres end-to-end (connect wizard, sync trigger, edit modal, status reconcile, customer-facing error messages, Cloud Scheduler recurring syncs via OIDC-authed HTTP target). 8 other connector wizards added by the connector chat (mysql, stripe, shopify, hubspot, google-ads, facebook-ads, salesforce, mailchimp); image building tracked separately. 50-source catalogue with search + category filter on the Connections page.
- **Agent**: Gemini 2.5 Flash via Vertex AI with function calling (list_tables, run_sql, make_chart, make_dashboard). Streaming SSE to client. Token usage logged to `liveli_internal.usage_events`.
- **Usage tracking**: append-only `usage_events` table + GBP cost estimates per Vertex/BQ/Cloud Run call.
- **Infra**: Terraform-managed APIs, Firestore, BigQuery (workspace + internal datasets), Cloud Run Jobs (per connector type, shared), Cloud Scheduler, Secret Manager, WIF for Vercel + GH Actions.

Pending (Phase 2 / launch blockers, tracked in Linear):
- Per-client SA + impersonation chain (LIVELI-?)
- Per-customer Cloud Run Jobs as a tier upgrade
- Region selection at workspace creation (LIVELI-46) — agent region MUST be derived from workspace.bqLocation, NOT a global env var
- Soft-delete with 30-day grace (LIVELI-75)
- Remove email allowlist (LIVELI-69)
- Production Clerk instance switch (LIVELI-72)
- DNS for app.liveli.co.uk + www.liveli.co.uk (LIVELI-21 partial)

## Env

See `.env.example`. Production uses Workload Identity Federation (no JSON keys); local dev uses `GOOGLE_APPLICATION_CREDENTIALS` pointing at a service-account file.
