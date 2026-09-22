import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { once } from "node:events";
import session from "express-session";
import request from "supertest";
import { io as connectSocket } from "socket.io-client";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { createApplication } from "../src/app.js";
import { readConfig } from "../src/config.js";
import { migrate } from "../src/db/migrate.js";

// PGlite runs actual PostgreSQL SQL in-process, with one connection. The gate keeps
// transaction statements together. TEST_DATABASE_URL switches to a real pool and
// an isolated schema for multi-connection/row-lock tests using the same suite.
export async function testPool() {
  if (process.env.TEST_DATABASE_URL) {
    const admin = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    const schema = `test_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    await migrate(pool);
    return {
      pool,
      async close() {
        await pool.end();
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
      },
    };
  }
  const db = new PGlite();
  const migrationsDir = new URL("../src/db/migrations/", import.meta.url);
  const migrations = (await readdir(migrationsDir))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of migrations) {
    await db.exec(await readFile(new URL(file, migrationsDir), "utf8"));
  }
  let pending = Promise.resolve();
  async function acquire() {
    const previous = pending;
    let release;
    pending = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }
  async function query(text, values) {
    if (!values && text.includes(";")) {
      const results = await db.exec(text);
      return results.at(-1) ?? { rows: [], rowCount: 0 };
    }
    const result = await db.query(text, values);
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  }
  const pool = {
    async query(text, values) {
      const release = await acquire();
      try {
        return await query(text, values);
      } finally {
        release();
      }
    },
    async connect() {
      const release = await acquire();
      return { query, release };
    },
  };
  return { pool, close: () => db.close() };
}

export async function createFixture(t, overrides = {}) {
  const database = await testPool();
  const config = {
    ...readConfig({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://test:test@localhost/test",
      SESSION_SECRET: "tests-only-long-session-secret-do-not-use-in-production",
      ENABLE_DEMO: "true",
    }),
    ...overrides,
  };
  const store = new session.MemoryStore();
  const server = createApplication({
    pool: database.pool,
    config,
    sessionStore: store,
  });
  server.httpServer.listen(0, "127.0.0.1");
  await once(server.httpServer, "listening");
  const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.disconnect();
    await new Promise((resolve) => server.io.close(resolve));
    store.clear();
    await database.close();
  });

  async function account(
    role = "client",
    name = `User ${randomUUID().slice(0, 6)}`,
  ) {
    const agent = request.agent(server.app);
    let response = await agent.get("/api/auth/csrf").expect(200);
    const email = `${randomUUID()}@example.test`;
    response = await agent
      .post("/api/auth/register")
      .set("X-CSRF-Token", response.body.csrfToken)
      .send({ fullName: name, email, password: "test-password-123", role })
      .expect(201);
    const cookie = response.headers["set-cookie"]
      .map((value) => value.split(";")[0])
      .join("; ");
    const user = {
      ...response.body.user,
      agent,
      csrfToken: response.body.csrfToken,
      cookie,
      password: "test-password-123",
    };
    user.request = (method, path, body) => {
      const req = agent[method.toLowerCase()](path).set(
        "X-CSRF-Token",
        user.csrfToken,
      );
      return body === undefined ? req : req.send(body);
    };
    user.socket = async (options = {}) => {
      const socket = connectSocket(baseUrl, {
        transports: ["websocket"],
        forceNew: true,
        reconnection: false,
        extraHeaders: { Cookie: cookie },
        auth: { csrfToken: user.csrfToken },
        ...options,
      });
      sockets.push(socket);
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Socket connect timed out")),
          5000,
        );
        socket.once("connect", () => {
          clearTimeout(timeout);
          resolve();
        });
        socket.once("connect_error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });
      return socket;
    };
    return user;
  }
  return { ...server, pool: database.pool, config, baseUrl, account, store };
}

export function emit(socket, event, payload) {
  return new Promise((resolve, reject) => {
    socket
      .timeout(5000)
      .emit(event, payload, (error, result) =>
        error ? reject(error) : resolve(result),
      );
  });
}

export function event(socket, name, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const handler = (value) => {
      clearTimeout(timeout);
      resolve(value);
    };
    const timeout = setTimeout(() => {
      socket.off(name, handler);
      reject(new Error(`Timed out waiting for ${name}`));
    }, timeoutMs);
    socket.once(name, handler);
  });
}
