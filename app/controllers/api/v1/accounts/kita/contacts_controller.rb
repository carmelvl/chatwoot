# Kita: the Customers page's Contacts tab, people filterable by customer.
class Api::V1::Accounts::Kita::ContactsController < Api::V1::Accounts::BaseController
  def index
    render json: ::Kita::Contacts.new(::Kita::Viewer.new(Current.account, Current.user), params).result
  end
end
