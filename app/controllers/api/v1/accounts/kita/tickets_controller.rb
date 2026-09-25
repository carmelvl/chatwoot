# Kita: the Tickets page, every Grip ticket across the customers the agent can see.
class Api::V1::Accounts::Kita::TicketsController < Api::V1::Accounts::BaseController
  def index
    render json: { payload: ::Kita::Tickets.new(::Kita::Viewer.new(Current.account, Current.user), params).rows }
  rescue ::Kita::Tickets::InvalidFilter => e
    render_could_not_create_error(e.message)
  end
end
