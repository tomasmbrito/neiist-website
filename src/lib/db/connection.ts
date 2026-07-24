import { Pool, QueryResult, QueryResultRow } from "pg";

// HMR-safe global connection pooling for Next.js development
declare global {
  var pgPool: Pool | undefined;
}

export const pool =
  global.pgPool ||
  new Pool({
    connectionString: process.env.DATABASE_URL,
  });

if (process.env.NODE_ENV !== "production") {
  global.pgPool = pool;
}

export const db_query = async <T extends QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> => {
  try {
    return await pool.query<T>(text, params);
  } catch (error) {
    console.error("Database query error:", error);
    throw error;
  }
};
