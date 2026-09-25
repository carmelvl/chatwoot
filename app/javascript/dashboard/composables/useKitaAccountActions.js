import { useI18n } from 'vue-i18n';
import { useStore } from 'vuex';
import { useAlert } from 'dashboard/composables';
import KitaInboxAPI from 'dashboard/api/kitaInbox';
import wootConstants from 'dashboard/constants/globals';
import { findSnoozeTime } from 'dashboard/helper/snoozeHelpers';

const { SNOOZE_OPTIONS } = wootConstants;

// Snooze choices of the header and bulk bar (null wake time: until the next reply)
export const KITA_SNOOZE_OPTIONS = [
  SNOOZE_OPTIONS.AN_HOUR_FROM_NOW,
  SNOOZE_OPTIONS.UNTIL_TOMORROW,
  SNOOZE_OPTIONS.UNTIL_NEXT_WEEK,
  SNOOZE_OPTIONS.UNTIL_NEXT_REPLY,
];

/**
 * Kita: actions on whole Inbox rows (every conversation of each customer):
 * resolve all, reopen, snooze, assign, label, team, not a customer. Refreshes
 * the Inbox and the open customer afterwards.
 */
export const useKitaAccountActions = () => {
  const { t } = useI18n();
  const store = useStore();

  const act = async (ids, actionName, params = {}) => {
    try {
      const { data } = await KitaInboxAPI.act({
        ids,
        action_name: actionName,
        ...params,
      });
      useAlert(t('KITA_INBOX.ACTION_DONE', { count: data.updated }));
      store.dispatch('kitaInbox/fetch').catch(() => {});
      store.dispatch('kitaInbox/fetchNeedsReplyCount').catch(() => {});
      ids.forEach(id =>
        store.dispatch('kitaCustomers/show', id).catch(() => {})
      );
      return true;
    } catch {
      useAlert(t('KITA_INBOX.ACTION_ERROR'));
      return false;
    }
  };

  const snooze = (ids, option) =>
    act(ids, 'snooze', { snoozed_until: findSnoozeTime(option) });

  return { act, snooze };
};
