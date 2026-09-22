import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createPool } from "./pool.js";

export async function migrate(pool) {
  const directory = new URL("./migrations/", import.meta.url);
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  await pool.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );

  for (const name of names) {
    const { rows } = await pool.query(
      "SELECT 1 FROM schema_migrations WHERE name = $1",
      [name],
    );
    if (rows.length) continue;

    await pool.query("BEGIN");
    try {
      await pool.query(await readFile(new URL(name, directory), "utf8"));
      await pool.query(
        "INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING",
        [name],
      );
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK").catch(() => {});
      if (error && ["42P07", "42710"].includes(error.code)) {
        // The database already contains the schema for a previously-run migration.
        // Treat the migration as applied so local dev databases remain usable.
        await pool.query(
          "INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING",
          [name],
        );
        continue;
      }
      throw error;
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (!process.env.DATABASE_URL)
    throw new Error(
      "DATABASE_URL is required. Copy .env.example to .env first.",
    );
  const pool = createPool(process.env.DATABASE_URL);
  try {
    await migrate(pool);
    console.log("Database migrations applied.");
  } finally {
    await pool.end();
  }
}
