import KitaInboxAPI from 'dashboard/api/kitaInbox';
import {
  actions,
  getters,
  mutations,
  state as initialState,
  SET_KITA_INBOX,
  SET_KITA_INBOX_FILTERS,
  SET_KITA_INBOX_NEEDS_REPLY,
} from '../../kitaInbox';

vi.mock('dashboard/api/kitaInbox', () => ({
  default: { get: vi.fn() },
}));

const freshState = () => JSON.parse(JSON.stringify(initialState));

describe('kitaInbox store', () => {
  it('loads page 1 with the filters, then appends the next page', async () => {
    const state = freshState();
    const commit = vi.fn((type, payload) => mutations[type](state, payload));
    mutations[SET_KITA_INBOX_FILTERS](state, { scope: 'all', label: 'vip' });
    KitaInboxAPI.get.mockResolvedValueOnce({
      data: { payload: [{ id: '7' }], meta: { page: 1, has_more: true } },
    });
    await actions.fetch({ commit, state });
    expect(KitaInboxAPI.get).toHaveBeenLastCalledWith({
      scope: 'all',
      status: 'open',
      labels: ['vip'],
      page: 1,
    });
    expect(state.rows).toEqual([{ id: '7' }]);

    KitaInboxAPI.get.mockResolvedValueOnce({
      data: { payload: [{ id: '9' }], meta: { page: 2, has_more: false } },
    });
    await actions.fetch({ commit, state }, { more: true });
    expect(KitaInboxAPI.get.mock.calls.at(-1)[0].page).toBe(2);
    expect(state.rows.map(row => row.id)).toEqual(['7', '9']);
    expect(state.isFetching).toBe(false);
  });

  it('ignores a response for filters that changed meanwhile', async () => {
    const state = freshState();
    const commit = vi.fn((type, payload) => mutations[type](state, payload));
    let resolveSlow;
    KitaInboxAPI.get.mockReturnValueOnce(
      new Promise(resolve => {
        resolveSlow = resolve;
      })
    );
    const slow = actions.fetch({ commit, state });
    KitaInboxAPI.get.mockResolvedValueOnce({
      data: { payload: [{ id: 'new' }], meta: { page: 1 } },
    });
    await actions.fetch({ commit, state });
    resolveSlow({ data: { payload: [{ id: 'old' }], meta: { page: 1 } } });
    await slow;
    expect(state.rows).toEqual([{ id: 'new' }]);
  });

  it('keeps the sidebar badge and finds rows', async () => {
    const state = freshState();
    const commit = vi.fn((type, payload) => mutations[type](state, payload));
    KitaInboxAPI.get.mockResolvedValueOnce({
      data: { payload: [], meta: { needs_reply: 4 } },
    });
    await actions.fetchNeedsReplyCount({ commit });
    expect(KitaInboxAPI.get).toHaveBeenLastCalledWith({
      scope: 'mine',
      status: 'open',
      meta_only: true,
    });
    expect(commit).toHaveBeenCalledWith(SET_KITA_INBOX_NEEDS_REPLY, 4);
    expect(getters.getNeedsReplyCount(state)).toBe(4);
    mutations[SET_KITA_INBOX](state, { rows: [{ id: 7 }], meta: {} });
    expect(getters.getRow(state)('7')).toEqual({ id: 7 });
  });
});
