/* global axios */
import ApiClient from './ApiClient';

class KitaConnectionsAPI extends ApiClient {
  constructor() {
    super('kita/connections');
  }

  get() {
    return axios.get(this.url);
  }
}

export default new KitaConnectionsAPI();
