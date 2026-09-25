/* global axios */
import ApiClient from './ApiClient';

class KitaCustomersAPI extends ApiClient {
  constructor() {
    super('kita/customers', { accountScoped: true });
  }

  get({ mine = false } = {}) {
    return axios.get(this.url, { params: mine ? { mine: true } : {} });
  }

  show(id) {
    return axios.get(`${this.url}/${encodeURIComponent(id)}`);
  }

  lookup(conversationId) {
    return axios.get(`${this.url}/lookup`, {
      params: { conversation_id: conversationId },
    });
  }

  myView() {
    return axios.post(`${this.url}/my_view`);
  }
}

export default new KitaCustomersAPI();
