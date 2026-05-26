# Liveli dbt-runner — shared Cloud Run Job for ALL connector transformations.
#
# Differs from connector-X-to-bq images: there's no tap installed,
# just dbt-core + dbt-bigquery + the entire dbt/ project baked in.
# Per-execution env vars name the customer's dataset + which
# connector-type's models to run (via `--select tag:<type>`).
#
# Build context is `connectors/dbt-runner/`; we COPY `../../dbt/` to
# bring the project in. Dockerfile uses a parent-dir COPY which
# requires the build context to be at the repo root — but
# deploy-connectors.yml uses `working-directory: connectors/<name>`,
# so we instead use a script that the deploy workflow runs to assemble
# the build context before docker build. See entrypoint.sh + the
# README in this dir for the build-context note.
#
# Actually — simpler: the deploy workflow runs `docker build .` with
# the connectors/dbt-runner dir as context. We have to either:
#   (a) duplicate dbt/ files into connectors/dbt-runner/dbt/, OR
#   (b) run a pre-build copy step in the workflow.
# Both are awkward. Cleanest: change the workflow's working-directory
# for THIS image only to be the repo root, and point Dockerfile path
# to connectors/dbt-runner/Dockerfile. That keeps the source of truth
# in dbt/ without duplication.
#
# For v1 we do that — the workflow needs a small case for dbt-runner.
# See the deploy-connectors.yml change in this PR.

FROM python:3.11-slim

WORKDIR /app

# System deps for dbt-bigquery's BQ client (uses google-cloud-bigquery)
# — needs git for `dbt deps` to pull dbt-utils from GitHub.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install dbt-core + BQ adapter. Pin minor versions to avoid surprise
# breakage on container rebuild; bump intentionally when we want new
# features.
RUN pip install --no-cache-dir \
    'dbt-core>=1.9.0,<1.10.0' \
    'dbt-bigquery>=1.9.0,<1.10.0'

# Copy the dbt project. Build context is repo root (set by the
# workflow); paths are relative to that.
COPY dbt /app/dbt

# Pre-resolve dbt packages so the runtime doesn't depend on GitHub
# being reachable + the package version being resolvable. `dbt deps`
# pulls dbt-utils from the GitHub URL into dbt_packages/.
RUN cd /app/dbt && dbt deps --profiles-dir /app/dbt

# Entrypoint script lives at the repo root's connectors/dbt-runner/.
COPY connectors/dbt-runner/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]
