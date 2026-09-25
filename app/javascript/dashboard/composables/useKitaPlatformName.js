import { useI18n } from 'vue-i18n';

/** Display name of a Kita bridge platform (slack/teams/whatsapp/viber); '' for anything else. */
export const useKitaPlatformName = () => {
  const { t } = useI18n();
  return platform => {
    const names = {
      slack: t('KITA_CONNECT.PLATFORMS.SLACK'),
      teams: t('KITA_CONNECT.PLATFORMS.TEAMS'),
      whatsapp: t('KITA_CONNECT.PLATFORMS.WHATSAPP'),
      viber: t('KITA_CONNECT.PLATFORMS.VIBER'),
    };
    return names[platform] ?? '';
  };
};
