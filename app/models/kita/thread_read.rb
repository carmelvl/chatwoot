# Kita: when an agent last read a thread (drives the thread list's unread flag).
class Kita::ThreadRead < ApplicationRecord
  self.table_name = 'kita_thread_reads'

  belongs_to :user
  belongs_to :conversation
  belongs_to :root_message, class_name: 'Message'

  validates :last_read_at, presence: true
  validates :root_message_id, uniqueness: { scope: :user_id }
end
