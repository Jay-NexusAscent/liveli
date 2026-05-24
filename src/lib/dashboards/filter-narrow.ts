/**
 * Narrow the Gemini-flat filter input shape (single object with
 * all-types optional fields, used by make_dashboard / update_dashboard
 * tool schemas) into the strict FilterDef discriminated-union shape
 * used by the render endpoint + Firestore.
 *
 * Why the flat → narrow split:
 *   - Gemini's Schema proto can't represent `z.union()` /
 *     `z.discriminatedUnion()`, so the wire schema must be a single
 *     flat object with `type` as a discriminator.
 *   - The render endpoint expects the strict FilterDef union — that's
 *     what makes `byId.get(filterId).type === "date_range"` work
 *     cleanly downstream.
 *
 * Each tool inlines its own `FilterInputSchema` (Zod) to avoid sharing
 * nested Zod schemas across tools (the zod→Gemini converter has known
 * fragility around shared / $ref-emitting schemas). But the narrow
 * step is pure TS, so it lives here and gets imported by both tools.
 */

import type {
  FilterDef,
  DateRangePreset,
  Granularity,
} from "./types";

/**
 * Shape produced by the Gemini-flat FilterInputSchema. Declared as a
 * plain interface (not z.infer) so this module doesn't import zod.
 * The tool-local schemas must match this shape — if you change one,
 * change both.
 */
export interface FilterInputShape {
  id: string;
  type: "date_range" | "granularity" | "select" | "multi_select";
  label: string;
  column?: string;
  options?: string[];
  defaultDateRange?: {
    mode: "preset" | "custom";
    preset?: string;
    start?: string;
    end?: string;
  };
  defaultGranularity?: "DAY" | "WEEK" | "MONTH" | "QUARTER" | "YEAR";
  defaultSelect?: string;
  defaultMultiSelect?: string[];
}

/**
 * Narrow one filter. Throws with a helpful message if per-type
 * required fields are missing — we fail fast at tool-call time so the
 * agent gets a clear correction signal, rather than letting an
 * unresolved placeholder bubble up at SQL-substitution time.
 */
export function narrowFilter(raw: FilterInputShape): FilterDef {
  const { id, type, label } = raw;
  switch (type) {
    case "date_range": {
      const d = raw.defaultDateRange;
      if (!d) {
        throw new Error(`Filter "${id}" of type date_range needs defaultDateRange.`);
      }
      if (d.mode === "preset") {
        if (!d.preset) {
          throw new Error(
            `Filter "${id}" date_range default mode=preset requires defaultDateRange.preset.`
          );
        }
        return {
          id,
          type: "date_range",
          label,
          defaultValue: { mode: "preset", preset: d.preset as DateRangePreset },
        };
      }
      if (!d.start || !d.end) {
        throw new Error(
          `Filter "${id}" date_range default mode=custom requires defaultDateRange.start and .end.`
        );
      }
      return {
        id,
        type: "date_range",
        label,
        defaultValue: { mode: "custom", start: d.start, end: d.end },
      };
    }
    case "granularity": {
      if (!raw.defaultGranularity) {
        throw new Error(`Filter "${id}" of type granularity needs defaultGranularity.`);
      }
      return {
        id,
        type: "granularity",
        label,
        defaultValue: raw.defaultGranularity as Granularity,
      };
    }
    case "select": {
      if (!raw.column) {
        throw new Error(`Filter "${id}" of type select needs column.`);
      }
      return {
        id,
        type: "select",
        label,
        column: raw.column,
        options: raw.options ?? [],
        defaultValue: raw.defaultSelect ?? null,
      };
    }
    case "multi_select": {
      if (!raw.column) {
        throw new Error(`Filter "${id}" of type multi_select needs column.`);
      }
      return {
        id,
        type: "multi_select",
        label,
        column: raw.column,
        options: raw.options ?? [],
        defaultValue: raw.defaultMultiSelect ?? [],
      };
    }
  }
}
