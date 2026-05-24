// Flat-config-native setup for ESLint 9 + eslint-config-next 16.
//
// We import the two Next.js shareable configs directly rather than
// going through `@eslint/eslintrc`'s `FlatCompat.extends()` shim. The
// shim path (which earlier versions of this file used) crashes inside
// `@eslint/eslintrc@3.x`'s config-validator with:
//
//   TypeError: Converting circular structure to JSON
//   ... property 'react' closes the circle
//
// — because eslint-config-next@16 ships flat-config-native modules
// whose React plugin object holds the well-known `configs.flat`
// self-reference, and FlatCompat tries to JSON-serialise them as if
// they were legacy eslintrc shapes. Native flat imports skip that
// validation step entirely.
//
// Both `core-web-vitals` and `typescript` are already arrays of flat
// config objects with their own `name`s; spreading them is equivalent
// to extending both, but with no compatibility shim in the loop.
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

/**
 * Design-system token discipline.
 *
 * Forbids the `bg-accent/N` opacity-shortcut pattern (e.g.
 * `bg-accent/90`, `hover:bg-accent/80`) and the analogous
 * `text-accent/N` pattern in Tailwind className strings. The
 * opacity shortcut leaks the indigo brand colour into a component
 * via a literal opacity number, bypassing the curated `accent-
 * hover` token in globals.css. When the design system retunes the
 * indigo hover behaviour, components using `bg-accent/90` won't
 * track the change; ones using `hover:bg-accent-hover` will.
 *
 * Matches both standalone string literals (className="…") and
 * template literals (className={`…`}). `warn`, not `error`, so the
 * rule guides without blocking — the project's lint step is
 * informational while eslint-config-next + FlatCompat is unstable.
 *
 * Caveat: `bg-[color:var(--status-error)]/90` is a similar pattern
 * but legitimate today (no `--status-error-hover` token exists).
 * If/when we add one, extend the regex below to forbid that too.
 */
const designTokenDiscipline = {
  name: "liveli/design-token-discipline",
  rules: {
    "no-restricted-syntax": [
      "warn",
      {
        selector: "Literal[value=/bg-accent\\/[0-9]+|text-accent\\/[0-9]+/]",
        message:
          "Tailwind opacity shortcut on an accent token. Use the curated `bg-accent-hover` / `hover:bg-accent-hover` token from globals.css instead — it tracks design-system changes; the /N shortcut doesn't.",
      },
      {
        selector:
          "TemplateElement[value.raw=/bg-accent\\/[0-9]+|text-accent\\/[0-9]+/]",
        message:
          "Tailwind opacity shortcut on an accent token. Use the curated `bg-accent-hover` / `hover:bg-accent-hover` token from globals.css instead — it tracks design-system changes; the /N shortcut doesn't.",
      },
    ],
  },
};

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  designTokenDiscipline,
];

export default eslintConfig;
