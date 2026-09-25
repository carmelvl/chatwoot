# Kita: the Grip ticket fields the desk shows per thread (sent by kita-grip-sync). All nullable: older Grips
# send no display id.
class AddTicketFieldsToKitaThreads < ActiveRecord::Migration[7.1]
  def change
    add_column :kita_threads, :ticket_display_id, :string
    add_column :kita_threads, :ticket_priority, :string
    add_column :kita_threads, :ticket_status, :string
    add_column :kita_threads, :ticket_owner, :string
  end
end
