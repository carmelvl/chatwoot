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

  # Conversations that are mine: I'm the customer's DRI (account_owner_email), the conversation is assigned to me,
  # I own one of its open Grip tickets, or I was mentioned in it.
  def mine(scope)
    tickets = ::Kita::MessageThread.where(::Kita::Customers::OPEN_TICKET).where('LOWER(kita_threads.ticket_owner) IN (?)', names_and_emails)
    scope.where(assignee_id: user.id)
         .or(scope.where("LOWER(conversations.custom_attributes->>'account_owner_email') IN (?)", emails))
         .or(scope.where(id: tickets.select(:conversation_id)))
         .or(scope.where(id: account.mentions.where(user: user).select(:conversation_id)))
  end

  # How grip-sync may name me as a ticket owner
  def names_and_emails
    [user.name.to_s.downcase, *emails].compact_blank
  end
end
