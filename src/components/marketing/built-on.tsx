/**
 * Built-on strip — sits right after the hero. Establishes credibility
 * up front by naming the infrastructure Liveli is built on, rather
 * than faking a "Trusted by [customer logos]" section before there
 * are real customers to point to.
 *
 * Text-only by design — embedding third-party brand SVGs introduces
 * licensing/asset-management overhead for marginal trust signal at
 * this stage. The names alone are recognisable to the technical
 * buyer who reads this section.
 */

const BUILT_ON = [
  "Google BigQuery",
  "Vertex AI",
  "Cloud Run",
  "Meltano",
  "Clerk",
];

export function BuiltOnStrip() {
  return (
    <section className="border-y border-border-subtle bg-background/40">
      <div className="container-page py-12 sm:py-14">
        <p className="mb-6 text-center text-[11px] font-medium uppercase tracking-[0.2em] text-text-tertiary">
          Built on infrastructure you already trust
        </p>
        <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-4 sm:gap-x-14">
          {BUILT_ON.map((name) => (
            <span
              key={name}
              className="text-[15px] font-medium tracking-tight text-text-secondary transition-colors hover:text-text-primary"
            >
              {name}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
