# Kita: the Customers page (conversations grouped by Grip account) and the "My customers" saved view.
class Api::V1::Accounts::Kita::CustomersController < Api::V1::Accounts::BaseController
  MY_VIEW_NAME = 'My customers'.freeze

  def index
    rows = ::Kita::Customers.new(accessible_conversations).rows
    rows = rows.select { |row| mine?(row[:dri_email]) } if ActiveModel::Type::Boolean.new.cast(params[:mine])
    render json: { payload: rows }
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

  def accessible_conversations
    Current.account.conversations.where(inbox_id: Current.user.assigned_inboxes.select(:id))
  end

  def mine?(email)
    email.present? && ::Kita::Bridge.normalize_email(email) == ::Kita::Bridge.normalize_email(Current.user.email)
  end

  def my_emails
    me = ::Kita::Bridge.normalize_email(Current.user.email)
    local, domain = me.split('@', 2)
    aliases = ::Kita::Bridge.domain_aliases.select { |_from, to| to == domain }.keys
    [me, *aliases.map { |alias_domain| "#{local}@#{alias_domain}" }]
  end

  def my_view_payload
    emails = my_emails
    emails.each_with_index.map do |email, index|
      {
        attribute_key: 'account_owner_email', custom_attribute_type: 'conversation_attribute',
        filter_operator: 'equal_to', values: [email], query_operator: index < emails.size - 1 ? 'or' : nil
      }
    end
  end
end
