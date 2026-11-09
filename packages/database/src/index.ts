import pg, { type PoolClient } from 'pg';

export * as schema from './schema.js';
export type Tx = PoolClient;

// pg intentionally leaves PostgreSQL bigint/numeric as strings at the boundary.
export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 10 });
}

export async function withTransaction<T>(
  pool: pg.Pool,
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const result = await work(tx);
      await tx.query('COMMIT');
      return result;
    } catch (error) {
      await tx.query('ROLLBACK');
      const code = (error as { code?: string }).code;
      if (attempt >= 2 || (code !== '40P01' && code !== '40001')) throw error;
    } finally {
      tx.release();
    }
  }
}
