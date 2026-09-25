# Kita: imported history (Kita::MessageBackfill) notifies no agent and runs no automation, hook or bot.
module Kita::QuietBackfill
  def message_created(event)
    return if event.data[:message].try(:kita_backfill?)

    super
  end
end
