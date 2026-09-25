# Kita: the desk's side of kita-grip-sync. Thread resolve/reopen in the desk moves that thread's Grip
# ticket: grip-sync owns the Grip API key, so the desk asks it (POST /kita/tickets/status, bridge secret).
module Kita::GripSync
  TIMEOUT = 5
  # Desk ticket words -> the status words grip-sync sends Grip.
  GRIP_STATUS = { 'resolved' => 'done', 'open' => 'todo' }.freeze

  module_function

  # Server-to-server base URL (inside docker compose grip-sync is `grip-sync:8080`).
  def internal_url
    ENV.fetch('GRIP_SYNC_INTERNAL_URL', 'http://grip-sync:8080').chomp('/')
  end

  def set_ticket_status(conversation, root_message_id, status)
    body = { conversation_id: conversation.display_id, root_message_id: root_message_id, status: GRIP_STATUS.fetch(status) }
    response = HTTParty.post("#{internal_url}/kita/tickets/status", body: body.to_json, timeout: TIMEOUT,
                                                                    headers: { 'Content-Type' => 'application/json',
                                                                               'X-Kita-Bridge-Secret' => ::Kita::Bridge.secret })
    raise "grip-sync ticket status #{response.code}" unless response.success?
  end
end
