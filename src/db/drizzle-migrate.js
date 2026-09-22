import "dotenv/config";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { fileURLToPath } from "node:url";
import { createPool } from "./pool.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");

const pool = createPool(process.env.DATABASE_URL);
const db = drizzle(pool);

try {
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL("./drizzle/", import.meta.url)),
  });
  console.log("Drizzle migrations applied.");
} finally {
  await pool.end();
}
