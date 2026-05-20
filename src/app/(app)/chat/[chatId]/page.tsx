import { ChatWindow } from "@/components/chat/chat-window";

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
  return <ChatWindow initialChatId={chatId} />;
}
