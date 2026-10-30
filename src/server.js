const { createApp } = require("./app");
const { openDb } = require("./db");

const env = process.env;
const app = createApp({
  db: openDb(env.DB_PATH || ":memory:"),
  version: env.APP_VERSION || "dev",
  commit: env.GIT_SHA || "local",
  chaos: {
    errorRate: Number(env.CHAOS_ERROR_RATE || 0),
    latencyMs: Number(env.CHAOS_LATENCY_MS || 0),
  },
});

const port = Number(env.PORT || 3000);
const server = app.listen(port, () => console.log(`bookings-api ${env.APP_VERSION || "dev"} listening on :${port}`));

// Let in-flight requests finish when the container is stopped.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
