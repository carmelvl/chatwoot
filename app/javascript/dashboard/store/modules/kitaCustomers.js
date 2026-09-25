import KitaCustomersAPI from 'dashboard/api/kitaCustomers';

export const SET_KITA_CUSTOMERS = 'SET_KITA_CUSTOMERS';
export const SET_KITA_CUSTOMER = 'SET_KITA_CUSTOMER';
export const SET_KITA_CUSTOMERS_LOADING = 'SET_KITA_CUSTOMERS_LOADING';

// Kita customers (Grip accounts) for the Customers directory, and single rows
// (any Inbox row id) for the conversation view's header.
export const state = {
  records: { mine: [], all: [] },
  byId: {},
  isFetching: false,
};

export const getters = {
  getCustomers: $state => scope => $state.records[scope] || [],
  getMyCustomers: $state => $state.records.mine,
  // The freshest copy: fetched on its own, else from a list already loaded
  getCustomer: ($state, _getters, _rootState, rootGetters) => id =>
    $state.byId[id] ??
    [...$state.records.mine, ...$state.records.all].find(
      customer => String(customer.id) === String(id)
    ) ??
    rootGetters['kitaInbox/getRow']?.(id) ??
    null,
  isFetching: $state => $state.isFetching,
};

export const actions = {
  async get({ commit }, { mine = false } = {}) {
    commit(SET_KITA_CUSTOMERS_LOADING, true);
    try {
      const { data } = await KitaCustomersAPI.get({ mine });
      commit(SET_KITA_CUSTOMERS, {
        scope: mine ? 'mine' : 'all',
        rows: data.payload,
      });
    } finally {
      commit(SET_KITA_CUSTOMERS_LOADING, false);
    }
  },
  async show({ commit }, id) {
    const { data } = await KitaCustomersAPI.show(id);
    commit(SET_KITA_CUSTOMER, data);
    return data;
  },
};

export const mutations = {
  [SET_KITA_CUSTOMERS]($state, { scope, rows }) {
    $state.records = { ...$state.records, [scope]: rows };
  },
  [SET_KITA_CUSTOMER]($state, customer) {
    $state.byId = { ...$state.byId, [customer.id]: customer };
  },
  [SET_KITA_CUSTOMERS_LOADING]($state, isFetching) {
    $state.isFetching = isFetching;
  },
};

export default { namespaced: true, state, getters, actions, mutations };
