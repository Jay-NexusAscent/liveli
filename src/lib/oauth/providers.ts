/**
 * Provider dispatcher. The generic OAuth routes
 * (/api/auth/oauth/[provider]/{start,callback}) read this map to
 * pick the right buildAuthUrl + exchangeCode + parseCallbackExtras
 * functions per `[provider]` segment.
 *
 * Adding a third provider (e.g. "slack") = drop a new module under
 * `oauth/<provider>.ts` exporting the same interface, register here.
 * The routes don't need to change.
 */

import {
  googleBuildAuthUrl,
  googleExchangeCode,
  googleScopesFor,
} from "@/lib/oauth/google";
import {
  intuitBuildAuthUrl,
  intuitExchangeCode,
  intuitParseCallbackExtras,
  intuitScopesFor,
} from "@/lib/oauth/intuit";
import type {
  OAuthConnectorType,
  OAuthProviderId,
  OAuthTokenSet,
} from "@/lib/oauth/types";

export interface OAuthProvider {
  /**
   * Connector types this provider supports. Used to validate the
   * `?type=` claim at start-route time and as the dispatch key for
   * scope selection. Mismatches are user-error / programming-error.
   */
  supportedTypes: OAuthConnectorType[];

  /** OAuth scopes Liveli will request for this connector type. */
  scopesFor(connectorType: OAuthConnectorType): string[];

  /** Build the provider's authorisation URL (state already signed). */
  buildAuthUrl(params: {
    state: string;
    scopes: string[];
    redirectUri: string;
  }): Promise<string>;

  /** Exchange authorisation code for the (access, refresh) token pair. */
  exchangeCode(params: {
    code: string;
    redirectUri: string;
  }): Promise<OAuthTokenSet>;

  /**
   * Pull provider-specific bonus params out of the callback URL
   * (Intuit hands the QuickBooks `realmId` here). Empty record for
   * providers that don't need it.
   */
  parseCallbackExtras(searchParams: URLSearchParams): Record<string, string>;
}

const PROVIDERS: Record<OAuthProviderId, OAuthProvider> = {
  google: {
    supportedTypes: ["ga4"],
    scopesFor: googleScopesFor,
    buildAuthUrl: googleBuildAuthUrl,
    exchangeCode: googleExchangeCode,
    parseCallbackExtras: () => ({}),
  },
  intuit: {
    supportedTypes: ["quickbooks"],
    scopesFor: intuitScopesFor,
    buildAuthUrl: intuitBuildAuthUrl,
    exchangeCode: intuitExchangeCode,
    parseCallbackExtras: intuitParseCallbackExtras,
  },
};

/**
 * Look up a provider by URL segment. Throws on unknown — caller
 * should map to a 404, but never silently fall through to a default.
 */
export function getProvider(id: string): OAuthProvider {
  const p = PROVIDERS[id as OAuthProviderId];
  if (!p) throw new UnknownProviderError(id);
  return p;
}

export function isKnownProvider(id: string): id is OAuthProviderId {
  return id in PROVIDERS;
}

export class UnknownProviderError extends Error {
  constructor(public id: string) {
    super(`Unknown OAuth provider "${id}"`);
    this.name = "UnknownProviderError";
  }
}
