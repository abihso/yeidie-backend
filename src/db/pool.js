import pg from 'pg';

export function createPool(connectionString) {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
  });
  pool.on('error', error => console.error('Idle database connection failed', { code: error.code }));
  return pool;
}
