const express = require("express");
const { setTimeout: sleep } = require("node:timers/promises");
const { z } = require("zod");
const { createMetrics } = require("./metrics");

// 30-minute slots from 09:00 to 16:30.
const SLOTS = [];
for (let h = 9; h <= 16; h++) for (const m of ["00", "30"]) SLOTS.push(`${String(h).padStart(2, "0")}:${m}`);

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    Object.assign(this, { status, code, details });
  }
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

const bookingInput = z
  .object({
    doctorId: z.number().int().positive(),
    patientName: z.string().trim().min(2).max(80),
    phone: z.string().regex(/^\+?[0-9 ]{7,15}$/, "invalid phone number"),
    date: isoDate,
    time: z.string().refine((t) => SLOTS.includes(t), "time must be a 30-minute slot between 09:00 and 16:30"),
  })
  .strict();

const listQuery = z.object({
  doctorId: z.coerce.number().int().positive().optional(),
  date: isoDate.optional(),
});

const statusUpdate = z.object({ status: z.literal("cancelled") }).strict();

function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) {
    const details = result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    throw new ApiError(400, "VALIDATION_FAILED", "Request is invalid", details);
  }
  return result.data;
}

const toAppointment = (r) => ({
  id: r.id,
  doctorId: r.doctor_id,
  patientName: r.patient_name,
  phone: r.phone,
  date: r.date,
  time: r.time,
  status: r.status,
  createdAt: r.created_at,
});

/**
 * @param {object} opts
 * @param {import("node:sqlite").DatabaseSync} opts.db
 * @param {string} [opts.version]  release version, shown by /version
 * @param {string} [opts.commit]   git commit the build came from
 * @param {{errorRate?: number, latencyMs?: number}} [opts.chaos]  fault injection for /api routes
 * @param {() => Date} [opts.now]
 * @param {() => number} [opts.random]
 */
function createApp({ db, version = "dev", commit = "local", chaos = {}, now = () => new Date(), random = Math.random }) {
  const app = express();
  const metrics = createMetrics();
  app.disable("x-powered-by");
  app.use(metrics.middleware);
  app.use(express.json({ limit: "10kb" }));
  app.use((req, res, next) => {
    res.set("X-App-Version", version);
    res.set("X-App-Commit", commit);
    next();
  });

  // ---- Operational endpoints
  app.get("/health", (req, res) => res.json({ status: "ok" }));
  app.get("/ready", (req, res) => {
    try {
      db.prepare("SELECT 1").get();
      res.json({ status: "ready" });
    } catch {
      res.status(503).json({ status: "not ready" });
    }
  });
  app.get("/version", (req, res) => res.json({ version, commit }));
  app.get("/metrics", async (req, res) => {
    res.set("Content-Type", metrics.registry.contentType);
    res.send(await metrics.registry.metrics());
  });

  // ---- Fault injection, used to rehearse alerts and rollbacks
  const api = express.Router();
  api.use(metrics.captureMount);
  api.use(async (req, res, next) => {
    if (chaos.latencyMs) await sleep(chaos.latencyMs);
    if (chaos.errorRate && random() < chaos.errorRate) throw new ApiError(500, "INJECTED_FAILURE", "Injected failure");
    next();
  });

  // ---- Business endpoints
  api.get("/doctors", (req, res) => {
    res.json(db.prepare("SELECT id, name, specialty FROM doctors ORDER BY id").all());
  });

  api.get("/slots", (req, res) => res.json(SLOTS));

  api.get("/appointments", (req, res) => {
    const q = parse(listQuery, req.query);
    const where = [];
    const args = [];
    if (q.doctorId) (where.push("doctor_id = ?"), args.push(q.doctorId));
    if (q.date) (where.push("date = ?"), args.push(q.date));
    const sql = `SELECT * FROM appointments ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY date, time LIMIT 200`;
    res.json(db.prepare(sql).all(...args).map(toAppointment));
  });

  api.post("/appointments", (req, res) => {
    const input = parse(bookingInput, req.body);
    const today = now().toISOString().slice(0, 10);
    if (Number.isNaN(Date.parse(input.date)) || input.date < today) {
      throw new ApiError(400, "VALIDATION_FAILED", "Request is invalid", [{ path: "date", message: "date must be today or later" }]);
    }
    if (!db.prepare("SELECT 1 FROM doctors WHERE id = ?").get(input.doctorId)) {
      throw new ApiError(404, "DOCTOR_NOT_FOUND", `Doctor ${input.doctorId} not found`);
    }
    let result;
    try {
      result = db
        .prepare("INSERT INTO appointments (doctor_id, patient_name, phone, date, time, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(input.doctorId, input.patientName, input.phone, input.date, input.time, now().toISOString());
    } catch (err) {
      if (String(err.message).includes("UNIQUE constraint failed")) {
        throw new ApiError(409, "SLOT_TAKEN", "This slot is already booked");
      }
      throw err;
    }
    metrics.bookings.inc();
    const row = db.prepare("SELECT * FROM appointments WHERE id = ?").get(result.lastInsertRowid);
    res.status(201).location(`/api/appointments/${row.id}`).json(toAppointment(row));
  });

  const findAppointment = (id) => {
    const row = /^\d+$/.test(id) && db.prepare("SELECT * FROM appointments WHERE id = ?").get(Number(id));
    if (!row) throw new ApiError(404, "NOT_FOUND", `Appointment ${id} not found`);
    return row;
  };

  api.get("/appointments/:id", (req, res) => res.json(toAppointment(findAppointment(req.params.id))));

  api.patch("/appointments/:id", (req, res) => {
    const row = findAppointment(req.params.id);
    const { status } = parse(statusUpdate, req.body);
    db.prepare("UPDATE appointments SET status = ? WHERE id = ?").run(status, row.id);
    res.json(toAppointment({ ...row, status }));
  });

  app.use("/api", api);

  // ---- Errors
  app.use((req, res) => res.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found" } }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === "entity.parse.failed") err = new ApiError(400, "INVALID_JSON", "Body is not valid JSON");
    if (!(err instanceof ApiError)) {
      console.error(err);
      err = new ApiError(500, "INTERNAL", "Something went wrong");
    }
    res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.details && { details: err.details }) } });
  });

  return app;
}

module.exports = { createApp, SLOTS };
