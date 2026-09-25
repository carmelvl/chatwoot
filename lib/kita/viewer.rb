# Kita: what one agent can see on the desk (the conversations of the inboxes they're a member of, all of
# them for admins) and who "me" is (my email across Kita's aliased domains), shared by the Inbox, Customers,
# Contacts and Tickets endpoints.
class Kita::Viewer
  attr_reader :account, :user

  def initialize(account, user)
    @account = account
    @user = user
  end

  def conversations
    account.conversations.where(inbox_id: user.assigned_inboxes.select(:id))
  end

  # "carmel@kita.ai" plus "carmel@usekita.com" for every domain aliased to kita.ai
  def emails
    me = ::Kita::Bridge.normalize_email(user.email)
    local, domain = me.split('@', 2)
    aliases = ::Kita::Bridge.domain_aliases.select { |_from, to| to == domain }.keys
    [me, *aliases.map { |alias_domain| "#{local}@#{alias_domain}" }]
  end

  def me?(email)
    email.present? && ::Kita::Bridge.normalize_email(email) == ::Kita::Bridge.normalize_email(user.email)
  end

  # Conversations I own: I'm the customer's DRI (account_owner_email) or the conversation is assigned to me.
  def mine(scope)
    scope.where("conversations.assignee_id = :id OR LOWER(conversations.custom_attributes->>'account_owner_email') IN (:emails)",
                id: user.id, emails: emails)
  end
end
