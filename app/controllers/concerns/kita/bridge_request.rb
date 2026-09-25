# Kita: server-to-server endpoints for kita-bridges / kita-grip-sync. Authenticated by the shared
# X-Kita-Bridge-Secret (BRIDGE_LINK_SECRET), acting on the KITA_BRIDGE_ACCOUNT_ID account.
module Kita::BridgeRequest
  extend ActiveSupport::Concern

  included do
    skip_before_action :set_current_user
    before_action :authenticate_bridge!
  end

  private

  def authenticate_bridge!
    head :unauthorized unless ::Kita::Bridge.valid_secret?(request.headers['X-Kita-Bridge-Secret'])
  end

  def account
    @account ||= Account.find(ENV.fetch('KITA_BRIDGE_ACCOUNT_ID', '1'))
  end
end
