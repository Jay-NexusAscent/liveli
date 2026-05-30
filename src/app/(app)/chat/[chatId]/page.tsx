import { ChatWindow } from "@/components/chat/chat-window";
import { fetchWorkspaceSettingsForCurrentUser } from "@/lib/workspace-settings-server";

export const runtime = "nodejs";

/**
 * /chat/[chatId] — resume an existing chat. The ChatWindow loads the
 * past messages and reconstructs the prior turn blocks (text + tool
 * calls + charts + tables + dashboards) so the customer can pick up
 * where they left off.
 */
export default async function ResumeChatPage({
  params,
}: {
  params: Promise<{ chatId: string }>;
}) {
  const { chatId } = await params;
  const settings = await fetchWorkspaceSettingsForCurrentUser();
  return <ChatWindow initialChatId={chatId} settings={settings} />;
}
