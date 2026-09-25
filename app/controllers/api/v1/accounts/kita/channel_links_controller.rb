# Kita: "Link to customer" for an unlinked channel. The bridge holds the Grip key and calls Grip (search accounts,
# PATCH the channel link), then merges the channel's conversation under the customer right away.
class Api::V1::Accounts::Kita::ChannelLinksController < Api::V1::Accounts::BaseController
  before_action :check_admin_authorization?

  def accounts
    render json: { payload: ::Kita::Bridge.grip_accounts(params[:search].to_s) }
  rescue ::Kita::Bridge::LinkError => e
    render json: { error: e.message }, status: :bad_gateway
  end

  def create
    conversation = Current.account.conversations.find_by!(display_id: params.require(:conversation_id))
    channel_key = conversation.custom_attributes&.dig('channel_key')
    return render_could_not_create_error('This conversation has no channel to link') if channel_key.blank?

    ::Kita::Bridge.link_channel(channel_key, params.require(:account_id).to_s)
    head :ok
  rescue ::Kita::Bridge::LinkError => e
    render json: { error: e.message }, status: e.status == 404 ? :not_found : :bad_gateway
  end
end
