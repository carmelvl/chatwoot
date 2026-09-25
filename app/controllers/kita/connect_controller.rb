# Kita: "Connect accounts" from the desk. Opened in a new browser tab, so it also accepts the
# dashboard's session cookie (cw_d_session_info) in place of the devise_token_auth headers.
class Kita::ConnectController < ApplicationController
  prepend_before_action :use_dashboard_session_cookie

  def show
    return redirect_to '/app/login' if current_user.blank?

    redirect_to Kita::Bridge.connect_url(current_user), allow_other_host: true
  end

  private

  def use_dashboard_session_cookie
    return if request.headers['access-token'].present? || cookies[:cw_d_session_info].blank?

    session_info = JSON.parse(cookies[:cw_d_session_info])
    %w[access-token client uid].each { |key| request.headers[key] = session_info[key] }
  rescue JSON::ParserError
    nil
  end
end
