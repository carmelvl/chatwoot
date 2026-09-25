/* global axios */
import ApiClient from './ApiClient';

// "Link to customer": the desk asks the bridge, which holds the Grip key
class KitaChannelLinksAPI extends ApiClient {
  constructor() {
    super('kita/channel_links', { accountScoped: true });
  }

  searchAccounts(search) {
    return axios.get(`${this.url}/accounts`, { params: { search } });
  }

  link(conversationId, accountId) {
    return axios.post(this.url, {
      conversation_id: conversationId,
      // account_id would clash with the desk account in the URL
      grip_account_id: accountId,
    });
  }
}

export default new KitaChannelLinksAPI();
