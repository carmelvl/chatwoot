# Kita: the Customers directory (conversations grouped by Grip account, plus unlinked channels), one customer
# (the header of the conversation view) and the "My customers" saved view.
class Api::V1::Accounts::Kita::CustomersController < Api::V1::Accounts::BaseController
  MY_VIEW_NAME = 'My customers'.freeze

  def index
    rows = ::Kita::Customers.new(viewer.conversations).rows.reject { |row| row[:kind] == 'conversation' }
    # Unlinked channels are nobody's yet, so they show under Mine too (to be linked)
    rows = rows.select { |row| row[:unlinked] || viewer.me?(row[:dri_email]) } if ActiveModel::Type::Boolean.new.cast(params[:mine])
    render json: { payload: rows }
  end

  # id: a Grip account id/name, "unlinked-<display id>" or "conversation-<display id>" (any Inbox row id)
  def show
    scope = viewer.conversations.where("#{::Kita::Customers::ROW_KEY} = ?", params[:id])
    row = ::Kita::Customers.new(scope).rows.first
    return head :not_found if row.nil?

    render json: row
  end

  # A per-user conversation view: account_owner_email is me (any aliased Kita domain).
  def my_view
    ensure_owner_email_attribute
    filter = Current.account.custom_filters.conversation.find_or_initialize_by(user: Current.user, name: MY_VIEW_NAME)
    filter.update!(query: { payload: my_view_payload })
    render json: { id: filter.id }
  end

  private

  # Chatwoot filters only custom attributes that have a definition (grip-sync normally creates it).
  def ensure_owner_email_attribute
    definitions = Current.account.custom_attribute_definitions
    definitions.find_or_create_by!(attribute_key: 'account_owner_email', attribute_model: :conversation_attribute) do |d|
      d.attribute_display_name = 'Account owner email'
      d.attribute_display_type = :text
    end
  end

  def viewer
    @viewer ||= ::Kita::Viewer.new(Current.account, Current.user)
  end

  def my_view_payload
    emails = viewer.emails
    emails.each_with_index.map do |email, index|
      {
        attribute_key: 'account_owner_email', custom_attribute_type: 'conversation_attribute',
        filter_operator: 'equal_to', values: [email], query_operator: index < emails.size - 1 ? 'or' : nil
      }
    end
  end
end
