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

// ── Collection layout ────────────────────────────────────────────
//
//   workspaces/{orgId}                       — mirror of Clerk org metadata
//     connectors/{connectorId}               — connector type, status, BQ dataset ref
//     chats/{chatId}                         — chat session metadata
//       messages/{messageId}                 — chat turn (user, assistant, tool_use, tool_result)
//     charts/{chartId}                       — saved chart spec
//     dashboards/{dashboardId}               — dashboard layout referencing charts
//
// Every read MUST be prefixed by `workspaces/{orgId}` to enforce multi-tenancy.
// `requireWorkspace()` extracts orgId from Clerk and asserts it.

export function workspace(orgId: string) {
  return db().collection("workspaces").doc(orgId);
}

export function connectors(orgId: string) {
  return workspace(orgId).collection("connectors");
}

export function chats(orgId: string) {
  return workspace(orgId).collection("chats");
}

export function messages(orgId: string, chatId: string) {
  return chats(orgId).doc(chatId).collection("messages");
}

export function charts(orgId: string) {
  return workspace(orgId).collection("charts");
}

export function dashboards(orgId: string) {
  return workspace(orgId).collection("dashboards");
}
