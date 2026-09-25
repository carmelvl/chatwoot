import KitaInboxAPI from 'dashboard/api/kitaInbox';
import { DEFAULT_INBOX_FILTERS, inboxParams } from 'dashboard/helper/kitaInbox';

export const SET_KITA_INBOX = 'SET_KITA_INBOX';
export const SET_KITA_INBOX_FILTERS = 'SET_KITA_INBOX_FILTERS';
export const SET_KITA_INBOX_FETCHING = 'SET_KITA_INBOX_FETCHING';
export const SET_KITA_INBOX_NEEDS_REPLY = 'SET_KITA_INBOX_NEEDS_REPLY';

// Kita Inbox: the rows on screen, their filters and paging
export const state = {
  rows: [],
  meta: { count: 0, page: 0, has_more: false, needs_reply: 0 },
  // My NEEDS REPLY count (the sidebar badge), whatever the list shows
  needsReplyCount: 0,
  filters: { ...DEFAULT_INBOX_FILTERS },
  isFetching: false,
  // Guards against a slow response for old filters landing after a new one
  requestId: 0,
};

export const getters = {
  getRows: $state => $state.rows,
  getMeta: $state => $state.meta,
  getFilters: $state => $state.filters,
  isFetching: $state => $state.isFetching,
  getNeedsReplyCount: $state => $state.needsReplyCount,
  getRow: $state => id =>
    $state.rows.find(row => String(row.id) === String(id)) ?? null,
};

export const actions = {
  /** Loads page 1 (replacing the rows) or, with more: true, the next page. */
  async fetch({ commit, state: $state }, { more = false } = {}) {
    const page = more ? $state.meta.page + 1 : 1;
    const requestId = $state.requestId + 1;
    commit(SET_KITA_INBOX_FETCHING, { isFetching: true, requestId });
    try {
      const { data } = await KitaInboxAPI.get(
        inboxParams($state.filters, page)
      );
      if (requestId !== $state.requestId) return;
      commit(SET_KITA_INBOX, {
        rows: more ? [...$state.rows, ...data.payload] : data.payload,
        meta: data.meta,
      });
    } finally {
      if (requestId === $state.requestId) {
        commit(SET_KITA_INBOX_FETCHING, { isFetching: false, requestId });
      }
    }
  },
  setFilters({ commit, dispatch }, filters) {
    commit(SET_KITA_INBOX_FILTERS, filters);
    return dispatch('fetch');
  },
  async fetchNeedsReplyCount({ commit }) {
    const { data } = await KitaInboxAPI.get({
      scope: 'mine',
      status: 'open',
      meta_only: true,
    });
    commit(SET_KITA_INBOX_NEEDS_REPLY, data.meta.needs_reply);
  },
};

export const mutations = {
  [SET_KITA_INBOX]($state, { rows, meta }) {
    $state.rows = rows;
    $state.meta = meta;
  },
  [SET_KITA_INBOX_FILTERS]($state, filters) {
    $state.filters = { ...DEFAULT_INBOX_FILTERS, ...filters };
  },
  [SET_KITA_INBOX_NEEDS_REPLY]($state, count) {
    $state.needsReplyCount = count;
  },
  [SET_KITA_INBOX_FETCHING]($state, { isFetching, requestId }) {
    $state.isFetching = isFetching;
    $state.requestId = requestId;
  },
};

export default { namespaced: true, state, getters, actions, mutations };
