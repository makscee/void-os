ALTER TABLE costs ADD COLUMN chat_id TEXT;
CREATE INDEX idx_costs_chat ON costs(chat_id, ts);
