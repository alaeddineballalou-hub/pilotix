// Cash: versements (cash_handovers) and the livreur chat, read fast.
export default `
CREATE INDEX IF NOT EXISTS orders_handover ON orders (handover_id) WHERE handover_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cash_handovers_created ON cash_handovers (created_at DESC);
CREATE INDEX IF NOT EXISTS chat_messages_unread ON chat_messages (livreur_id) WHERE read_at IS NULL;
`;
