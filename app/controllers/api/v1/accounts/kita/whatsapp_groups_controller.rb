# Kita: Customers -> WhatsApp groups. Connection status, the pair link and "Add group by invite link",
# proxied to kita-wa-groups with the bridge secret server side (it never reaches the browser).
class Api::V1::Accounts::Kita::WhatsappGroupsController < Api::V1::Accounts::BaseController
  PASSED_ON = [404, 409, 422, 429].freeze

  before_action :check_admin_authorization?

  def index
    render json: ::Kita::WaGroups.status
  rescue ::Kita::WaGroups::Error => e
    render json: { error: e.message }, status: :bad_gateway
  end

  def create
    render json: ::Kita::WaGroups.join(params.require(:invite_link).to_s)
  rescue ::Kita::WaGroups::Error => e
    render json: { error: e.message }, status: PASSED_ON.include?(e.status) ? e.status : :bad_gateway
  end

  def pair_link
    render json: { url: ::Kita::WaGroups.pair_url }
  end
end
