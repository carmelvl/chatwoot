# Kita: the threads of one desk conversation for one agent. A thread is a root message with replies
# (messages whose content_attributes.in_reply_to is the root's id) or a kita_threads metadata row.
# Row shape: {root_message_id, title, status, reply_count, last_reply_at (unix s), participants[], unread,
# ticket: {id, url, display_id, priority, status, owner, sla_due_at (unix s)}|nil, external_source, external_channel}, most recent activity first.
# messages.content_attributes is a json column holding a JSON-encoded string (Message stores it with
# coder: JSON), so it is unwrapped with #>> '{}' before the jsonb lookup; this also reads plain objects.
class Kita::Threads
  IN_REPLY_TO = "(messages.content_attributes #>> '{}')::jsonb ->> 'in_reply_to'".freeze
  ROOT_ID = "(#{IN_REPLY_TO})::bigint".freeze
  PARTICIPANT_LIMIT = 5

  def initialize(conversation, user)
    @conversation = conversation
    @user = user
  end

  def rows
    @stats = reply_stats
    @metadata = ::Kita::MessageThread.where(conversation_id: @conversation.id).index_by(&:root_message_id)
    roots = @conversation.messages.where(id: @stats.keys | @metadata.keys).to_a
    @reads = ::Kita::ThreadRead.where(user_id: @user.id, root_message_id: roots.map(&:id)).pluck(:root_message_id, :last_read_at).to_h
    @participants = participants
    roots.map { |root| row(root) }.sort_by { |row| -row[:activity] }.map { |row| row.except(:activity) }
  end

  private

  def replies
    @conversation.messages.reorder(nil).where("#{IN_REPLY_TO} ~ '^[0-9]+$'")
  end

  # root id => [reply count, last reply at, last reply at by someone other than this agent]
  def reply_stats
    others = ActiveRecord::Base.sanitize_sql_array(
      ["MAX(messages.created_at) FILTER (WHERE messages.sender_type IS DISTINCT FROM 'User' OR messages.sender_id <> ?)", @user.id]
    )
    replies.group(Arel.sql(ROOT_ID)).pluck(Arel.sql(ROOT_ID), Arel.sql('COUNT(*)'), Arel.sql('MAX(messages.created_at)'), Arel.sql(others))
           .to_h { |root_id, *values| [root_id, values] }
  end

  # root id => up to PARTICIPANT_LIMIT distinct reply senders, earliest first
  def participants
    pairs = replies.where.not(sender_id: nil).group(Arel.sql(ROOT_ID), :sender_type, :sender_id)
                   .order(Arel.sql('MIN(messages.created_at)')).pluck(Arel.sql(ROOT_ID), :sender_type, :sender_id)
    senders = senders_for(pairs)
    pairs.group_by(&:first).transform_values do |rows|
      rows.filter_map { |_root, type, id| senders[[type, id]] }.first(PARTICIPANT_LIMIT)
    end
  end

  def senders_for(pairs)
    pairs.map { |_root, type, id| [type, id] }.uniq.group_by(&:first).flat_map do |type, keys|
      next [] unless %w[User Contact].include?(type)

      type.constantize.where(id: keys.map(&:last)).map { |sender| [[type, sender.id], participant(sender)] }
    end.to_h
  end

  def participant(sender)
    { id: sender.id, type: sender.class.name, name: sender.name, thumbnail: sender.avatar_url }
  end

  def row(root)
    count, last_reply_at, last_other_at = @stats.fetch(root.id, [0, nil, nil])
    attrs = root.content_attributes
    metadata(root.id).merge(
      root_message_id: root.id, reply_count: count, last_reply_at: last_reply_at&.to_i,
      participants: @participants.fetch(root.id, []), unread: unread?(root.id, last_other_at),
      external_source: attrs['external_source'], external_channel: attrs['external_channel'],
      activity: (last_reply_at || root.created_at).to_f
    )
  end

  def metadata(root_id)
    thread = @metadata[root_id]
    return { title: nil, status: 'open', ticket: nil } if thread.nil?

    if thread.ticket_id.present?
      ticket = { id: thread.ticket_id, url: thread.ticket_url, display_id: thread.ticket_display_id, priority: thread.ticket_priority,
                 status: thread.ticket_status, owner: thread.ticket_owner, sla_due_at: thread.ticket_sla_due_at&.to_i }
    end
    { title: thread.title, status: thread.status, ticket: ticket }
  end

  def unread?(root_id, last_other_at)
    return false if last_other_at.nil?

    read_at = @reads[root_id]
    read_at.nil? || last_other_at > read_at
  end
end
