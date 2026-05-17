# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

**Liveli** — an AI data-analytics product. Users connect data sources (Meltano), Liveli ingests into BigQuery, and an AI agent (Claude via Vertex AI) answers natural-language questions and builds dashboards.

Not to be confused with **Liveli Ltd** the voice-agent product in `liveli-portal`. Same brand, separate product, no shared code.

## Architecture

**One Next.js app, two domains:**
- `liveli.co.uk` → route group `(marketing)` — public landing
- `app.liveli.co.uk` → route group `(app)` — auth-walled product
- Subdomain split happens in [middleware.ts](middleware.ts) via the `Host` header

**Route groups:**
- `src/app/(marketing)/*` — public, no sidebar
- `src/app/(auth)/*` — Clerk sign-in/up
- `src/app/(app)/*` — authenticated, sidebar layout, three tabs: Chat / Connections / Dashboards

**GCP project:** `liveli-496609`, region `europe-west4` (Vertex AI, Cloud Run, Artifact Registry, Secret Manager). BigQuery and GCS use `EU` multi-region. Firestore uses `eur3` multi-region.

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

Commits and PR titles should reference Linear issues by their prefix (e.g. `LIV-12: wire chat to vertex`). The Linear GitHub integration auto-links them.

## Stage of build

This is an early scaffold. Wired so far: marketing landing, auth pages, app shell with 3 placeholder tabs, middleware, design system. Pending: Clerk Organizations onboarding, Firestore client, BigQuery client, Vertex AI agent wiring, Meltano Cloud Run Job, dashboards persistence, Terraform.

## Env

See `.env.example`. Production uses Workload Identity Federation (no JSON keys); local dev uses `GOOGLE_APPLICATION_CREDENTIALS` pointing at a service-account file.
