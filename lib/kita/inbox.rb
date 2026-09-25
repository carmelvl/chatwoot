# Kita: the Inbox, the desk's one list. Rows are Kita::Customers rows (one per customer, unlinked channel or
# other conversation) built from the conversations that match the filters, ordered and paginated by row.
#
# Filters (all optional):
#   mine        - I'm the DRI or the conversation is assigned to me
#   status      - needs_reply (default: open and the latest public message is the customer's), open, pending,
#                 snoozed, resolved or all
#   platform    - slack, teams, whatsapp, viber (bridge conversations on that platform)
#   labels[]    - any of these labels; team_id; inbox_id
#   conversation_type - mention, participating or unattended (the classic Mentions/Participating/Unattended views)
#   filters     - a Chatwoot advanced-filter / saved-view payload as JSON ([{attribute_key, filter_operator, values, query_operator}])
#   sort        - latest (default), oldest, created_desc, created_asc, priority
#   page        - 1-based, PER_PAGE rows a page
class Kita::Inbox
  PER_PAGE = 25
  STATUSES = %w[needs_reply open pending snoozed resolved all].freeze
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

  class InvalidFilter < StandardError; end

  def initialize(viewer, params)
    @viewer = viewer
    @params = params
  end

  def result
    keys = ordered_keys
    page = [@params[:page].to_i, 1].max
    page_keys = keys.slice((page - 1) * PER_PAGE, PER_PAGE) || []
    rows = page_keys.any? ? ::Kita::Customers.new(conversations.where("#{::Kita::Customers::ROW_KEY} IN (?)", page_keys)).rows : []
    rows = rows.index_by { |row| row[:id] }.values_at(*page_keys).compact
    { payload: rows, meta: { count: keys.size, page: page, per_page: PER_PAGE, has_more: keys.size > page * PER_PAGE } }
  end

  # The conversations matching every filter, as a plain relation (no joins or preloads) for grouping.
  def conversations
    @conversations ||= begin
      scope = base
      scope = @viewer.mine(scope) if ActiveModel::Type::Boolean.new.cast(@params[:mine])
      scope = filter_status(scope)
      scope = filter_platforms(scope)
      scope = scope.where(team_id: @params[:team_id]) if @params[:team_id].present?
      scope = scope.where(inbox_id: @params[:inbox_id]) if @params[:inbox_id].present?
      scope = scope.tagged_with(Array(@params[:labels]), any: true) if @params[:labels].present?
      scope = filter_conversation_type(scope)
      @viewer.account.conversations.where(id: scope.unscope(:order, :includes, :preload).select(:id))
    end
  end

  private

  def ordered_keys
    sort = SORTS.fetch(@params[:sort].presence || 'latest') { raise InvalidFilter, "Invalid sort: #{@params[:sort]}" }
    conversations.reorder(nil).group(Arel.sql(::Kita::Customers::ROW_KEY)).order(Arel.sql(sort))
                 .pluck(Arel.sql(::Kita::Customers::ROW_KEY))
  end

  # A saved view or advanced filter runs through Chatwoot's own filter service (same permissions and operators).
  def base
    return @viewer.conversations if @params[:filters].blank?

    ::Kita::FilteredConversations.new({ payload: advanced_filters }.with_indifferent_access, @viewer.user, @viewer.account).relation
                                 .where(inbox_id: @viewer.user.assigned_inboxes.select(:id))
  end

  def advanced_filters
    filters = JSON.parse(@params[:filters])
    raise InvalidFilter, 'filters must be a list' unless filters.is_a?(Array)

    filters
  rescue JSON::ParserError
    raise InvalidFilter, 'filters must be JSON'
  end

  def filter_status(scope)
    status = @params[:status].presence || 'needs_reply'
    raise InvalidFilter, "Invalid status: #{status}" unless STATUSES.include?(status)

    case status
    when 'all' then scope
    when 'needs_reply'
      scope.where(status: :open).where("#{::Kita::Customers::LAST_PUBLIC_MESSAGE_TYPE} = ?", Message.message_types[:incoming])
    else scope.where(status: status)
    end
  end

  def filter_platforms(scope)
    platforms = Array(@params[:platform]).compact_blank
    return scope if platforms.empty?
    raise InvalidFilter, "Invalid platform: #{platforms.join(', ')}" unless (platforms - PLATFORMS).empty?

    scope.where("conversations.custom_attributes->>'channel' IN (?)", platforms)
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
