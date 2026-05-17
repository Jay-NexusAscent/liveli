# Liveli

Talk to your business data. Liveli connects your data sources, runs the warehouse for you, and gives your team an AI analyst that answers questions and builds dashboards in plain English.

## Surfaces

- **`liveli.co.uk`** — marketing site (route group `(marketing)`)
- **`app.liveli.co.uk`** — authenticated product (route group `(app)`)
- **Auth pages** (`/sign-in`, `/sign-up`) live on both subdomains

One Next.js app, two domains, host-based routing via [middleware.ts](middleware.ts).

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router, React 19, TypeScript) |
| Styling | Tailwind 4 (CSS-first config in `src/app/globals.css`) |
| Auth | Clerk + Organizations (workspaces) |
| Metadata DB | Firestore (`eur3` multi-region) |
| Warehouse | BigQuery (`EU` multi-region) |
| Connectors | Meltano on Cloud Run Jobs |
| Secrets | Google Secret Manager |
| Agent | Claude Opus 4.7 (via Vertex AI in `us-central1`) |
| Charts | Apache ECharts |
| Object storage | GCS (`EU` multi-region) |
| Infra-as-code | Terraform (see `infra/`) |
| CI/CD | GitHub Actions + Vercel Git integration + Workload Identity Federation |

GCP project: **`liveli-496609`**.

## Local development

```bash
pnpm install
cp .env.example .env.local   # fill in keys
pnpm dev                     # http://localhost:3000
```

For the app subdomain locally, hit `http://app.localhost:3000` — the middleware will redirect `/` to `/chat`. You'll need a Clerk publishable + secret key first.

## Deployment

Pushes to `main` deploy to Vercel automatically. Vercel project is linked to this repo; domains `liveli.co.uk`, `www.liveli.co.uk`, and `app.liveli.co.uk` point at the same deployment.
