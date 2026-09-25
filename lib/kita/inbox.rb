# Kita: the Inbox, the desk's one work list. Rows are Kita::Customers rows (one per customer, unlinked channel or
# other conversation). Filters apply to conversations before grouping, so a customer is listed when any of its
# conversations matches; the row then shows only those conversations.
#
# Rows are ordered by section (needs reply, active, unlinked, snoozed, resolved), then within a section:
# needs reply = open urgent/high tickets pinned first, then the longest wait; the others most recent first. A sort
# param replaces the order within sections.
#
# Filters (all optional):
#   scope       - mine (default: I'm the DRI, the assignee, the owner of an open ticket, or I was mentioned),
#                 unassigned (no DRI, or waiting on us with no assignee) or all
#   view_id     - one of my saved views (Chatwoot custom filter of type conversation)
#   filters     - a Chatwoot advanced-filter payload as JSON ([{attribute_key, filter_operator, values, query_operator}])
#   status      - open (default), needs_reply (open and waiting on us), snoozed, resolved, all, or other
#                 (channels marked "Not a customer", hidden elsewhere)
#   platform    - slack, teams, whatsapp, viber
#   dri         - the DRI's email; labels[]; team_id; inbox_id; stage
#   ticket_priority, ticket_status - the conversation has a Grip ticket with this priority/status (open = not closed)
#   conversation_type - mention, participating or unattended (the classic views)
#   sort        - latest, oldest, created_desc, created_asc, priority
#   page        - 1-based, PER_PAGE rows a page
#   meta_only   - only meta.needs_reply (the sidebar badge)
class Kita::Inbox
  PER_PAGE = 25
  SCOPES = %w[mine unassigned all].freeze
  STATUSES = %w[needs_reply open snoozed resolved all other].freeze
  PLATFORMS = %w[slack teams whatsapp viber].freeze
  PRIORITY_RANK = "MAX(CASE conversations.priority WHEN #{Conversation.priorities[:urgent]} THEN 4 " \
                  "WHEN #{Conversation.priorities[:high]} THEN 3 WHEN #{Conversation.priorities[:medium]} THEN 2 " \
                  "WHEN #{Conversation.priorities[:low]} THEN 1 ELSE 0 END)".freeze
  SORTS = {
    'latest' => 'MAX(conversations.last_activity_at) DESC',
    'oldest' => 'MAX(conversations.last_activity_at) ASC',
    'created_desc' => 'MAX(conversations.created_at) DESC',
    'created_asc' => 'MIN(conversations.created_at) ASC',
    'priority' => "#{PRIORITY_RANK} DESC, MAX(conversations.last_activity_at) DESC"
  }.freeze
  # Within a section: for needs reply, pressing tickets first then the longest wait; otherwise most recent
  SECTION_ORDER = <<~SQL.squish.freeze
    BOOL_OR(conversations.pressing AND conversations.needs_reply) DESC,
    MIN(COALESCE(conversations.waiting_since, conversations.last_activity_at)) FILTER (WHERE conversations.needs_reply) ASC NULLS LAST,
    MAX(conversations.last_activity_at) DESC
  SQL

  class InvalidFilter < StandardError; end

  def initialize(viewer, params)
    @viewer = viewer
    @params = params
  end

  def result
    return { payload: [], meta: { needs_reply: needs_reply_count } } if ActiveModel::Type::Boolean.new.cast(@params[:meta_only])

    keys = ordered_keys
    page = [@params[:page].to_i, 1].max
    page_keys = keys.slice((page - 1) * PER_PAGE, PER_PAGE) || []
    rows = page_keys.any? ? ::Kita::Customers.new(conversations.where("#{::Kita::Customers::ROW_KEY} IN (?)", page_keys)).rows : []
    rows = rows.index_by { |row| row[:id] }.values_at(*page_keys).compact
    meta = { count: keys.size, page: page, per_page: PER_PAGE, has_more: keys.size > page * PER_PAGE, needs_reply: needs_reply_count }
    { payload: rows, meta: meta }
  end

  # Rows waiting on us among those listed (the sidebar badge; unlinked channels count too)
  def needs_reply_count
    ::Kita::Customers.keyed(conversations.where(::Kita::Customers::NEEDS_REPLY)).distinct.count('conversations.row_key')
  end

  # The conversations matching every filter, as a plain relation (no joins or preloads) for grouping.
  def conversations
    @conversations ||= begin
      scope = filter_scope(base)
      scope = filter_status(scope)
      scope = filter_platforms(scope)
      scope = filter_attributes(scope)
      scope = filter_tickets(scope)
      scope = filter_conversation_type(scope)
      @viewer.account.conversations.where(id: scope.unscope(:order, :includes, :preload).select(:id))
    end
  end

  private

  def ordered_keys
    within = @params[:sort].present? ? SORTS.fetch(@params[:sort]) { raise InvalidFilter, "Invalid sort: #{@params[:sort]}" } : SECTION_ORDER
    ::Kita::Customers.keyed(conversations).group('conversations.row_key')
                     .order(Arel.sql("#{::Kita::Customers::SECTION_RANK}, #{within}")).pluck('conversations.row_key')
  end

  # A saved view or advanced filter runs through Chatwoot's own filter service (same permissions and operators).
  def base
    payload = advanced_filters
    return @viewer.conversations if payload.blank?

    ::Kita::FilteredConversations.new({ payload: payload }.with_indifferent_access, @viewer.user, @viewer.account).relation
                                 .where(inbox_id: @viewer.user.assigned_inboxes.select(:id))
  end

  def advanced_filters
    return saved_view_filters if @params[:view_id].present?
    return if @params[:filters].blank?

    filters = JSON.parse(@params[:filters])
    raise InvalidFilter, 'filters must be a list' unless filters.is_a?(Array)

    filters
  rescue JSON::ParserError
    raise InvalidFilter, 'filters must be JSON'
  end

  def saved_view_filters
    view = @viewer.account.custom_filters.conversation.find_by(id: @params[:view_id], user: @viewer.user)
    raise InvalidFilter, "Unknown view: #{@params[:view_id]}" if view.nil?

    view.query['payload']
  end

  def filter_scope(scope)
    case @params[:scope].presence || 'mine'
    when 'mine' then @viewer.mine(scope)
    when 'unassigned'
      scope.where("COALESCE(conversations.custom_attributes->>'account_owner_email', '') = '' " \
                  "OR (conversations.assignee_id IS NULL AND #{::Kita::Customers::NEEDS_REPLY})")
    when 'all' then scope
    else raise InvalidFilter, "Invalid scope: #{@params[:scope]}"
    end
  end

  def filter_status(scope)
    status = @params[:status].presence || 'open'
    raise InvalidFilter, "Invalid status: #{status}" unless STATUSES.include?(status)
    return scope.where(::Kita::Customers::NOT_CUSTOMER) if status == 'other'

    scope = scope.where.not(::Kita::Customers::NOT_CUSTOMER)
    case status
    when 'all' then scope
    when 'needs_reply' then scope.where(::Kita::Customers::NEEDS_REPLY)
    else scope.where(status: status)
    end
  end

  def filter_platforms(scope)
    platforms = Array(@params[:platform]).compact_blank
    return scope if platforms.empty?
    raise InvalidFilter, "Invalid platform: #{platforms.join(', ')}" unless (platforms - PLATFORMS).empty?

    scope.where("conversations.custom_attributes->>'channel' IN (?)", platforms)
  end

  def filter_attributes(scope)
    scope = scope.where(team_id: @params[:team_id]) if @params[:team_id].present?
    scope = scope.where(inbox_id: @params[:inbox_id]) if @params[:inbox_id].present?
    scope = scope.where(id: labelled(Array(@params[:labels])).select(:taggable_id)) if @params[:labels].present?
    scope = scope.where("conversations.custom_attributes->>'grip_stage' = ?", @params[:stage]) if @params[:stage].present?
    return scope if @params[:dri].blank?

    scope.where("LOWER(conversations.custom_attributes->>'account_owner_email') = ?", @params[:dri].to_s.downcase)
  end

  # Conversations with any of the labels (taggings; tagged_with's own select can't be a subquery)
  def labelled(labels)
    ActsAsTaggableOn::Tagging.joins(:tag).where(taggable_type: 'Conversation', context: 'labels', tags: { name: labels })
  end

  def filter_tickets(scope)
    return scope if @params[:ticket_priority].blank? && @params[:ticket_status].blank?

    tickets = ::Kita::MessageThread.where.not(ticket_id: nil)
    tickets = tickets.where(ticket_priority: @params[:ticket_priority]) if @params[:ticket_priority].present?
    case @params[:ticket_status].presence
    when nil then nil
    when 'open' then tickets = tickets.where(::Kita::Customers::OPEN_TICKET)
    else tickets = tickets.where(ticket_status: @params[:ticket_status])
    end
    scope.where(id: tickets.select(:conversation_id))
  end

  def filter_conversation_type(scope)
    user = @viewer.user
    case @params[:conversation_type].presence
    when nil then scope
    when 'mention' then scope.where(id: @viewer.account.mentions.where(user: user).select(:conversation_id))
    when 'participating'
      scope.where(id: ConversationParticipant.where(account_id: @viewer.account.id, user_id: user.id).select(:conversation_id))
    when 'unattended' then scope.unattended
    else raise InvalidFilter, "Invalid conversation type: #{@params[:conversation_type]}"
    end
  end
end
