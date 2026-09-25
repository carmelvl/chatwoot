import { reactive, ref } from 'vue';
import KitaThreadsAPI from 'dashboard/api/kitaThreads';

// Shared across the message list, thread pane and threads tab
const threadsByConversation = reactive({});
// { conversationId, rootId } of the thread shown in the right-side pane
const openThread = ref(null);
// Whether the conversation shows the Threads tab instead of the messages
const showThreadsTab = ref(false);

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

const setThreadStatus = async (conversationId, rootId, status) => {
  await KitaThreadsAPI.updateStatus(conversationId, rootId, status);
  const thread = findThread(conversationId, rootId);
  if (thread) thread.status = status;
};

/**
 * Kita customer-conversation threads (GET .../kita/conversations/:id/threads),
 * cached per conversation, plus the open thread pane state.
 */
export const useKitaThreads = () => ({
  threadsByConversation,
  openThread,
  showThreadsTab,
  fetchThreads,
  findThread,
  openThreadPane,
  closeThreadPane,
  setThreadStatus,
});
