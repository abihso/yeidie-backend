import { pathToFileURL } from "node:url";
import { readConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { migrate } from "./db/migrate.js";
import { createApplication } from "./app.js";

export async function startServer({
  config = readConfig(),
  pool,
  sessionStore,
} = {}) {
  const resolvedPool = pool ?? createPool(config.databaseUrl);
  try {
    await migrate(resolvedPool);
  } catch (error) {
    if (!pool) await resolvedPool.end();
    throw new Error("Database unavailable or could not be migrated.", {
      cause: error,
    });
  }

  const { app, httpServer, io, store } = createApplication({
    pool: resolvedPool,
    config,
    sessionStore,
  });

  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.port, config.host, () => {
      resolve({ app, httpServer, io, store, pool: resolvedPool });
    });
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const config = readConfig();
  const pool = createPool(config.databaseUrl);
  const { httpServer, io, store } = await startServer({ config, pool });
  console.log(`Yiedie API listening on http://${config.host}:${config.port}`);
  if (config.enableDemo)
    console.log(`Browser demo: http://localhost:${config.port}/demo/`);

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    const timeout = setTimeout(() => process.exit(1), 10000);
    timeout.unref();
    await new Promise((resolve) => io.close(resolve));
    store.close?.();
    await pool.end();
    clearTimeout(timeout);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  httpServer.on("error", (error) => {
    console.error("HTTP server error", { code: error.code });
    shutdown().then(() => {
      process.exitCode = 1;
    });
  });
}
