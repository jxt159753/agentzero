import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction } from '@agentzero/database';
import { refundSession } from './service.js';

export async function processGameTimeouts(pool: Pool) {
  const sessions = (await pool.query<{ id: string }>("SELECT id FROM arcade_game_sessions WHERE status IN ('playing','submitted') AND expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 100")).rows;
  for (const session of sessions) await withTransaction(pool, tx => refundSession(tx, { type: 'system' }, randomUUID(), session.id));
}
