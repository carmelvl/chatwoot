/* global axios */
import ApiClient from './ApiClient';

// Kita: the Inbox (one row per customer), account actions, Tickets and contacts
class KitaInboxAPI extends ApiClient {
  constructor() {
    super('kita', { accountScoped: true });
  }

  get(params) {
    return axios.get(`${this.url}/inbox`, { params });
  }

  tickets(params) {
    return axios.get(`${this.url}/tickets`, { params });
  }

  /** Resolve all, snooze, assign… on whole rows (ids) or conversations (conversation_ids) */
  act(params) {
    return axios.post(`${this.url}/account_actions`, params);
  }

  contacts(params) {
    return axios.get(`${this.url}/contacts`, { params });
  }
}

export default new KitaInboxAPI();
