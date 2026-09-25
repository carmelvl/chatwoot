# Kita: per-thread metadata on a desk conversation. A thread is a root message plus the messages whose
# content_attributes.in_reply_to point at it; this row adds the AI title, the Grip ticket link and a
# thread-level status (independent of the conversation's status). Named MessageThread so nothing in the
# Kita namespace shadows Ruby's ::Thread.
class Kita::MessageThread < ApplicationRecord
  self.table_name = 'kita_threads'

  belongs_to :account
  belongs_to :conversation
  belongs_to :root_message, class_name: 'Message'

  enum status: { open: 0, resolved: 1 }

  validates :root_message_id, uniqueness: true
end
