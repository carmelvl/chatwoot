import KitaCustomersAPI from 'dashboard/api/kitaCustomers';

export const SET_KITA_CUSTOMERS = 'SET_KITA_CUSTOMERS';
export const SET_KITA_CUSTOMERS_LOADING = 'SET_KITA_CUSTOMERS_LOADING';

// Kita customers (Grip accounts) for the Customers page, the sidebar count and "My customers".
export const state = {
  records: { mine: [], all: [] },
  isFetching: false,
};

export const getters = {
  getCustomers: $state => scope => $state.records[scope] || [],
  getMine: $state => $state.records.mine,
  getMineCount: $state => $state.records.mine.length,
  getCustomer: $state => id =>
    [...$state.records.mine, ...$state.records.all].find(
      customer => String(customer.id) === String(id)
    ) ?? null,
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
};

export const mutations = {
  [SET_KITA_CUSTOMERS]($state, { scope, rows }) {
    $state.records = { ...$state.records, [scope]: rows };
  },
  [SET_KITA_CUSTOMERS_LOADING]($state, isFetching) {
    $state.isFetching = isFetching;
  },
};

export default { namespaced: true, state, getters, actions, mutations };
