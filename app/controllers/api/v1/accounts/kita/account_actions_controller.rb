# Kita: resolve all, snooze, assign, label, team, "Not a customer" and "Replied from phone" on whole Inbox rows
# (see Kita::AccountActions).
class Api::V1::Accounts::Kita::AccountActionsController < Api::V1::Accounts::BaseController
  def create
    count = ::Kita::AccountActions.new(::Kita::Viewer.new(Current.account, Current.user), params).perform
    render json: { updated: count }
  rescue ::Kita::AccountActions::InvalidAction, ActionController::ParameterMissing => e
    render_could_not_create_error(e.message)
  end
end
