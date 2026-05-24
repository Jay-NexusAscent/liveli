import { Firestore } from "@google-cloud/firestore";
import { gcp } from "@/lib/gcp";
import { ensureGcpAuth } from "@/lib/gcp-auth";

let _db: Firestore | null = null;

export function db(): Firestore {
  if (_db) return _db;
  // preferRest:true — CRITICAL for Vercel/serverless. The Firestore SDK
  // defaults to gRPC over HTTP/2, which Vercel's serverless runtime can't
  // reliably establish. Failed channels surface as a google-gax error with
  // every field undefined ('Error: undefined undefined: undefined'). REST
  // transport (HTTPS/JSON) works everywhere serverless runs. BQ wasn't
  // affected because @google-cloud/bigquery uses REST by default.
  const settings: ConstructorParameters<typeof Firestore>[0] = {
    projectId: gcp.projectId,
    preferRest: true,
  };
  if (gcp.firestoreDatabase && gcp.firestoreDatabase !== "(default)") {
    settings.databaseId = gcp.firestoreDatabase;
  }
  _db = new Firestore(settings);
  return _db;
}

export async function dbReady(): Promise<Firestore> {
  await ensureGcpAuth();
  return db();
}

// ── Collection layout (post-Phase-1 migration) ──────────────────────
//
//   clients/{clerkOrgId}                  — Client (Clerk Org IS the Client)
//     ├── name, defaultWorkspaceId, serviceAccountEmail, billing.*
//     └── workspaces/{workspaceId}        — Workspace (sub-unit of Client)
//           ├── name, bqLocation, isDefault
//           ├── connectors/{connectorId}
//           ├── chats/{chatId}
//           │     └── messages/{messageId}
//           ├── charts/{chartId}
//           └── dashboards/{dashboardId}
//
//   users/{clerkUserId}                   — global user record (mirrors Clerk)
//
// Tenancy enforcement: every Firestore read MUST be prefixed by
// clientDoc(clientId). Use `requireWorkspaceContext()` in route handlers
// (see lib/clients.ts) to extract clientId + workspaceId from Clerk auth.
//
// The OLD layout below — top-level `workspaces` collection keyed by
// orgId — conflated Client and Workspace into a single concept and is
// being phased out. New code MUST use the new helpers.

// ── New helpers (use these in new code) ─────────────────────────────

export function clients() {
  return db().collection("clients");
}

export function clientDoc(clientId: string) {
  return clients().doc(clientId);
}

export function workspacesIn(clientId: string) {
  return clientDoc(clientId).collection("workspaces");
}

export function workspaceDoc(clientId: string, workspaceId: string) {
  return workspacesIn(clientId).doc(workspaceId);
}

export function connectorsIn(clientId: string, workspaceId: string) {
  return workspaceDoc(clientId, workspaceId).collection("connectors");
}

export function chatsIn(clientId: string, workspaceId: string) {
  return workspaceDoc(clientId, workspaceId).collection("chats");
}

export function messagesIn(clientId: string, workspaceId: string, chatId: string) {
  return chatsIn(clientId, workspaceId).doc(chatId).collection("messages");
}

export function chartsIn(clientId: string, workspaceId: string) {
  return workspaceDoc(clientId, workspaceId).collection("charts");
}

export function dashboardsIn(clientId: string, workspaceId: string) {
  return workspaceDoc(clientId, workspaceId).collection("dashboards");
}

export function insightsIn(clientId: string, workspaceId: string) {
  return workspaceDoc(clientId, workspaceId).collection("insights");
}

export function alertChannelsIn(clientId: string, workspaceId: string) {
  return workspaceDoc(clientId, workspaceId).collection("alertChannels");
}

export function userDoc(userId: string) {
  return db().collection("users").doc(userId);
}

// ── DEPRECATED: pre-Client-layer flat layout ────────────────────────
// Use the new clients()/workspacesIn()/connectorsIn() helpers instead.
// Retained while callsites are migrated commit-by-commit. Will be
// removed when no callsites remain.

/** @deprecated Use clientDoc(clientId) + workspacesIn(clientId) instead. */
export function workspace(orgId: string) {
  return db().collection("workspaces").doc(orgId);
}

/** @deprecated Use connectorsIn(clientId, workspaceId) instead. */
export function connectors(orgId: string) {
  return workspace(orgId).collection("connectors");
}

/** @deprecated Use chatsIn(clientId, workspaceId) instead. */
export function chats(orgId: string) {
  return workspace(orgId).collection("chats");
}

/** @deprecated Use messagesIn(clientId, workspaceId, chatId) instead. */
export function messages(orgId: string, chatId: string) {
  return chats(orgId).doc(chatId).collection("messages");
}

/** @deprecated Use chartsIn(clientId, workspaceId) instead. */
export function charts(orgId: string) {
  return workspace(orgId).collection("charts");
}

/** @deprecated Use dashboardsIn(clientId, workspaceId) instead. */
export function dashboards(orgId: string) {
  return workspace(orgId).collection("dashboards");
}
