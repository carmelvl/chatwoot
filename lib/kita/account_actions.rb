# Kita: an action on whole Inbox rows (customers, unlinked channels, other conversations), fanned out to every
# conversation of each row the agent can see:
#   resolve            - resolve them all; with close_tickets, also resolve their open Grip tickets (via grip-sync)
#   reopen             - reopen them all
#   snooze             - snooze them all until snoozed_until (unix seconds; nil = until the next reply)
#   assign             - assign them all to assignee_id (an agent of the account)
#   label              - add the label to them all
#   team               - move them all to team_id
#   not_customer       - archive them into the Other bucket (Inbox status=other; left out of Customers)
#   customer           - take them back out of Other
#   replied_from_phone - a WhatsApp/Viber reply the bridge didn't mirror: they no longer need a reply
class Kita::AccountActions
  ACTIONS = %w[resolve reopen snooze assign label team not_customer customer replied_from_phone].freeze

  class InvalidAction < StandardError; end

  def initialize(viewer, params)
    @viewer = viewer
    @params = params
  end

  # @return [Integer] how many conversations changed
  def perform
    action = @params[:action_name].to_s
    raise InvalidAction, "Invalid action: #{action}" unless ACTIONS.include?(action)

    list = conversations.to_a
    list.each { |conversation| send(action, conversation) }
    list.size
  end

  private

  def conversations
    ids = Array(@params[:ids]).compact_blank
    raise InvalidAction, 'ids are required' if ids.empty?

    @viewer.conversations.where("#{::Kita::Customers::ROW_KEY} IN (?)", ids)
  end

  def resolve(conversation)
    conversation.update!(status: :resolved)
    close_tickets(conversation) if ActiveModel::Type::Boolean.new.cast(@params[:close_tickets])
  end

  def reopen(conversation)
    conversation.update!(status: :open)
  end

  def snooze(conversation)
    until_at = @params[:snoozed_until].presence && Time.zone.at(@params[:snoozed_until].to_i)
    conversation.update!(status: :snoozed, snoozed_until: until_at)
  end

  def assign(conversation)
    @assignee ||= @viewer.account.users.find(@params.require(:assignee_id))
    conversation.update!(assignee: @assignee)
  end

  def label(conversation)
    conversation.add_labels([@params.require(:label)])
  end

  def team(conversation)
    @team ||= @viewer.account.teams.find(@params.require(:team_id))
    conversation.update!(team: @team)
  end

  def not_customer(conversation)
    conversation.update!(custom_attributes: (conversation.custom_attributes || {}).merge('kita_not_customer' => 'true'))
  end

  def customer(conversation)
    conversation.update!(custom_attributes: (conversation.custom_attributes || {}).except('kita_not_customer'))
  end

  def replied_from_phone(conversation)
    conversation.update!(custom_attributes: (conversation.custom_attributes || {}).merge('kita_replied_at' => Time.current.to_f.to_s))
  end

  # The thread status is the desk's own, so it is kept even when grip-sync can't be reached.
  def close_tickets(conversation)
    ::Kita::MessageThread.where(conversation: conversation).where(::Kita::Customers::OPEN_TICKET).find_each do |thread|
      thread.update!(status: :resolved)
      ::Kita::GripSync.set_ticket_status(conversation, thread.root_message_id, 'resolved')
      thread.update!(ticket_status: 'resolved')
    rescue StandardError => e
      Rails.logger.warn("kita grip-sync ticket status failed: #{e.message}")
    end
  end
end
