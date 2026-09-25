import { reactive, ref } from 'vue';
import KitaThreadsAPI from 'dashboard/api/kitaThreads';

// Shared across the message list, thread pane and threads tab
const threadsByConversation = reactive({});
// { conversationId, rootId } of the thread shown in the right-side pane
const openThread = ref(null);

const fetchThreads = async conversationId => {
  const { data } = await KitaThreadsAPI.get(conversationId);
  threadsByConversation[conversationId] = data.payload;
};

const findThread = (conversationId, rootId) =>
  (threadsByConversation[conversationId] || []).find(
    thread => thread.root_message_id === rootId
  ) ?? null;

const openThreadPane = (conversationId, rootId) => {
  openThread.value = { conversationId, rootId };
  const thread = findThread(conversationId, rootId);
  if (thread) thread.unread = false;
  KitaThreadsAPI.markRead(conversationId, rootId);
};

const closeThreadPane = () => {
  openThread.value = null;
};

/**
 * Resolves or reopens a thread, and its Grip ticket through grip-sync.
 * @returns {Promise<boolean|null>} Whether the ticket moved too (null: no ticket)
 */
const setThreadStatus = async (conversationId, rootId, status) => {
  const { data } = await KitaThreadsAPI.updateStatus(
    conversationId,
    rootId,
    status
  );
  const thread = findThread(conversationId, rootId);
  if (thread) {
    thread.status = status;
    if (thread.ticket && data.ticket_synced) {
      thread.ticket.status = status === 'resolved' ? 'resolved' : 'open';
    }
  }
  return data.ticket_synced ?? null;
};

/**
 * Kita customer-conversation threads (GET .../kita/conversations/:id/threads),
 * cached per conversation, plus the open thread pane state.
 */
export const useKitaThreads = () => ({
  threadsByConversation,
  openThread,
  fetchThreads,
  findThread,
  openThreadPane,
  closeThreadPane,
  setThreadStatus,
});
