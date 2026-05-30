/**
 * Bundle the metadata-agent Cloud Run Job entrypoint into a single
 * runnable file with esbuild.
 *
 * - Resolves the `@/*` tsconfig path alias to ./src (esbuild doesn't
 *   read tsconfig paths for non-relative imports by default, so we set
 *   it explicitly).
 * - `packages: "external"` keeps node_modules out of the bundle — the
 *   Docker image ships prod dependencies separately. The google-cloud
 *   SDKs use dynamic requires / native bits that don't bundle cleanly,
 *   so externalising them is the reliable choice.
 * - ESM output with a createRequire shim so any CJS interop inside the
 *   externalised deps resolves.
 *
 * Output: dist/metadata-agent/index.mjs
 */
import * as esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

await esbuild.build({
  entryPoints: [path.join(root, "scripts/metadata-agent-job.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: path.join(root, "dist/metadata-agent/index.mjs"),
  packages: "external",
  alias: {
    "@": path.join(root, "src"),
  },
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
  logLevel: "info",
});

console.log("[build-metadata-agent] bundled → dist/metadata-agent/index.mjs");
