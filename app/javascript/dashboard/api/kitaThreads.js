/* global axios */
import ApiClient from './ApiClient';

class KitaThreadsAPI extends ApiClient {
  constructor() {
    super('kita/conversations', { accountScoped: true });
  }

  get(conversationId) {
    return axios.get(`${this.url}/${conversationId}/threads`);
  }

  updateStatus(conversationId, rootMessageId, status) {
    return axios.patch(
      `${this.url}/${conversationId}/threads/${rootMessageId}`,
      { status }
    );
  }

  markRead(conversationId, rootMessageId) {
    return axios.post(
      `${this.url}/${conversationId}/threads/${rootMessageId}/read`
    );
  }
}

export default new KitaThreadsAPI();
