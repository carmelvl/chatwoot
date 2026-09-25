# Kita: the Customers directory (accounts by name, plus unlinked channels; channels marked "Not a customer" left out), one customer
# (the header of the conversation view) and the "My customers" saved view.
class Api::V1::Accounts::Kita::CustomersController < Api::V1::Accounts::BaseController
  MY_VIEW_NAME = 'My customers'.freeze

  def index
    conversations = viewer.conversations.where.not(::Kita::Customers::NOT_CUSTOMER)
    rows = ::Kita::Customers.new(conversations).rows(sort: :name).reject { |row| row[:kind] == 'conversation' }
    # Mine: the customers I'm the DRI of. Unlinked channels are nobody's, so never mine.
    rows = rows.select { |row| row[:kind] == 'customer' && viewer.me?(row[:dri_email]) } if ActiveModel::Type::Boolean.new.cast(params[:mine])
    medians = ::Kita::Customers.first_response_medians(conversations)
    render json: { payload: rows.map { |row| row.merge(first_response_median: medians[row[:id]]) } }
  end

  # Any row by its id: a Grip account id (or name), "unlinked-<platform>:<channel>" or "conversation-<display id>"
  def show
    render_row(viewer.conversations.where("#{::Kita::Customers::ROW_KEY} = ?", params[:id]))
  end

  # The row a conversation belongs to (the conversation view opened from a classic or notification link)
  def lookup
    conversation = viewer.conversations.find_by!(display_id: params.require(:conversation_id))
    key = ::Kita::Customers.row_ids(Conversation.where(id: conversation.id))[conversation.id]
    render_row(viewer.conversations.where("#{::Kita::Customers::ROW_KEY} = ?", key))
  end

  # A per-user conversation view: account_owner_email is me (any aliased Kita domain).
  def my_view
    ensure_owner_email_attribute
    filter = Current.account.custom_filters.conversation.find_or_initialize_by(user: Current.user, name: MY_VIEW_NAME)
    filter.update!(query: { payload: my_view_payload })
    render json: { id: filter.id }
  end

  private

  def render_row(scope)
    row = ::Kita::Customers.new(scope).rows.first
    return head :not_found if row.nil?

    render json: row
  end

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
