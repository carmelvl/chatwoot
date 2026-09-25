# Kita: the Inbox, one row per customer (see Kita::Inbox for the filters).
class Api::V1::Accounts::Kita::InboxController < Api::V1::Accounts::BaseController
  def index
    render json: ::Kita::Inbox.new(::Kita::Viewer.new(Current.account, Current.user), params).result
  rescue ::Kita::Inbox::InvalidFilter,
         CustomExceptions::CustomFilter::InvalidAttribute,
         CustomExceptions::CustomFilter::InvalidOperator,
         CustomExceptions::CustomFilter::InvalidQueryOperator,
         CustomExceptions::CustomFilter::InvalidValue => e
    render_could_not_create_error(e.message)
  end
end
