/* global axios */
import ApiClient from './ApiClient';

// WhatsApp groups: the desk asks kita-wa-groups through Rails, which holds the bridge secret
class KitaWhatsappGroupsAPI extends ApiClient {
  constructor() {
    super('kita/whatsapp_groups', { accountScoped: true });
  }

  status() {
    return axios.get(this.url);
  }

  join(inviteLink) {
    return axios.post(this.url, { invite_link: inviteLink });
  }

  pairLink() {
    return axios.get(`${this.url}/pair_link`);
  }
}

export default new KitaWhatsappGroupsAPI();
