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

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
];

export default eslintConfig;
