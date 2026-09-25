# Kita: people (Chatwoot contacts) for the Customers page's Contacts tab. A contact belongs to a customer when it
# is a conversation's contact or has sent a message in one of the customer's conversations.
# Row shape: {id, name, email, phone_number, thumbnail, customers[{id, name}]}; most recently active first.
class Kita::Contacts
  PER_PAGE = 30

  def initialize(viewer, params)
    @viewer = viewer
    @params = params
  end

  def result
    scope = contacts
    page = [@params[:page].to_i, 1].max
    list = scope.order(Arel.sql('contacts.last_activity_at DESC NULLS LAST, contacts.id DESC')).offset((page - 1) * PER_PAGE).limit(PER_PAGE).to_a
    customers = customers_by_contact(list.map(&:id))
    rows = list.map do |contact|
      { id: contact.id, name: contact.name, email: contact.email, phone_number: contact.phone_number, thumbnail: contact.avatar_url,
        customers: customers.fetch(contact.id, []) }
    end
    { payload: rows, meta: { count: scope.count, page: page, per_page: PER_PAGE } }
  end

  private

  def conversations
    scope = @viewer.conversations
    customer_id = @params[:customer_id].presence
    customer_id ? scope.where("#{::Kita::Customers::ROW_KEY} = ?", customer_id) : scope
  end

  def contacts
    scope = @viewer.account.contacts.where(id: conversations.select(:contact_id))
                   .or(@viewer.account.contacts.where(id: senders.select(:sender_id)))
    return scope if @params[:q].blank?

    scope.where('contacts.name ILIKE :q OR contacts.email ILIKE :q', q: "%#{ActiveRecord::Base.sanitize_sql_like(@params[:q])}%")
  end

  def senders
    Message.where(conversation_id: conversations.select(:id), sender_type: 'Contact')
  end

  # contact id => customers [{id, name}] among the conversations in view
  def customers_by_contact(ids)
    key = Arel.sql(::Kita::Customers::ROW_KEY)
    name = Arel.sql("conversations.custom_attributes->>'grip_account'")
    pairs = conversations.where(contact_id: ids).distinct.pluck(:contact_id, key, name)
    pairs += conversations.joins(:messages).where(messages: { sender_type: 'Contact', sender_id: ids })
                          .distinct.pluck(Arel.sql('messages.sender_id'), key, name)
    pairs.select { |_contact, _key, customer| customer.present? }.uniq.group_by(&:first)
         .transform_values { |rows| rows.map { |_contact, id, customer| { id: id, name: customer } }.uniq }
  end
end
