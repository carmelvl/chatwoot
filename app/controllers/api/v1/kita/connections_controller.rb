# Kita: the current agent's Slack / Teams / WhatsApp / Viber connection status, from kita-bridges.
class Api::V1::Kita::ConnectionsController < Api::BaseController
  def show
    render json: ::Kita::Bridge.status(Current.user)
  rescue StandardError => e
    Rails.logger.warn("kita_bridge_status_failed: #{e.class.name}")
    render json: { error: 'bridge_unavailable' }, status: :bad_gateway
  end
end
