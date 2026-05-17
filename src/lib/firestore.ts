import { Firestore } from "@google-cloud/firestore";
import { gcp } from "@/lib/gcp";

let _db: Firestore | null = null;

export function db(): Firestore {
  if (_db) return _db;
  _db = new Firestore({
    projectId: gcp.projectId,
    databaseId: gcp.firestoreDatabase,
  });
  return _db;
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
