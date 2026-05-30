import { ChatWindow } from "@/components/chat/chat-window";
import { fetchWorkspaceSettingsForCurrentUser } from "@/lib/workspace-settings-server";

export const runtime = "nodejs";

export default async function ChatPage() {
  // Server-fetch the workspace settings so the chat renderer threads
  // currency/locale/timezone through to every chart without an extra
  // client round-trip on mount. Falls back to defaults if the user
  // isn't authenticated or has no org yet.
  const settings = await fetchWorkspaceSettingsForCurrentUser();
  return <ChatWindow settings={settings} />;
}
