import type { FilterDef, FilterValues } from "./types";

/**
 * Compute the initial FilterValues for a dashboard's filter set —
 * each filter's `defaultValue` keyed by its `id`.
 *
 * Used in two places client-side:
 *
 *   1. Initial hydration when localStorage has no saved state for
 *      this dashboard yet — gives a sensible starting point that
 *      matches the agent's stored chart spec (the agent renders each
 *      chart at create time using these same defaults, so the user's
 *      first view is consistent with that snapshot).
 *
 *   2. The "Reset" affordance on the filter bar — call this to wipe
 *      user customisations back to the dashboard's authored defaults.
 *
 * The return shape exactly matches what the server-side render endpoint
 * accepts, so the client can pass these values straight through to
 * POST /api/dashboards/<id>/render.
 */
export function defaultFilterValues(filters: FilterDef[]): FilterValues {
  const out: FilterValues = {};
  for (const f of filters) {
    switch (f.type) {
      case "date_range":
        // defaultValue is already the right shape — either
        // { mode: "preset", preset } or { mode: "custom", start, end }.
        out[f.id] = f.defaultValue;
        break;
      case "granularity":
        out[f.id] = f.defaultValue;
        break;
      case "select":
        out[f.id] = f.defaultValue; // string | null
        break;
      case "multi_select":
        out[f.id] = f.defaultValue; // string[]
        break;
    }
  }
  return out;
}
