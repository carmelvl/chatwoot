class CreateKitaThreads < ActiveRecord::Migration[7.1]
  def change
    create_table :kita_threads do |t|
      t.references :account, null: false, index: true
      t.references :conversation, null: false, index: true
      t.bigint :root_message_id, null: false, index: { unique: true }
      t.string :title
      t.integer :status, null: false, default: 0
      t.string :ticket_id
      t.string :ticket_url
      t.timestamps
    end

    create_table :kita_thread_reads do |t|
      t.references :user, null: false, index: false
      t.references :conversation, null: false, index: true
      t.bigint :root_message_id, null: false
      t.datetime :last_read_at, null: false
      t.timestamps
    end
    add_index :kita_thread_reads, [:user_id, :root_message_id], unique: true
  end
end
