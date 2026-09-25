# Kita: history imported by kita-bridges keeps its original timestamps and stays quiet (lib/kita/message_backfill.rb).
Rails.application.config.to_prepare do
  Message.prepend(Kita::MessageBackfill)
  [NotificationListener, AutomationRuleListener, HookListener, AgentBotListener].each { |listener| listener.prepend(Kita::QuietBackfill) }
end
