const request = require("supertest");
const { createApp } = require("../../src/app");
const { openDb } = require("../../src/db");
const { assertContract } = require("../contract");

describe("operational endpoints", () => {
  const app = createApp({ db: openDb(), version: "1.4.0", commit: "abc1234" });

  test("liveness and readiness", async () => {
    const health = await request(app).get("/health").expect(200);
    assertContract("/health", "get", 200, health.body);
    const ready = await request(app).get("/ready").expect(200);
    assertContract("/ready", "get", 200, ready.body);
  });

  test("readiness fails when the database is gone", async () => {
    const db = openDb();
    const broken = createApp({ db });
    db.close();
    await request(broken).get("/ready").expect(503);
  });

  test("reports the running release in the body and headers", async () => {
    const res = await request(app).get("/version").expect(200);
    assertContract("/version", "get", 200, res.body);
    expect(res.body).toEqual({ version: "1.4.0", commit: "abc1234" });
    expect(res.headers["x-app-commit"]).toBe("abc1234");
  });

  test("exposes Prometheus metrics labelled by route pattern", async () => {
    await request(app).get("/api/appointments/123");
    const res = await request(app).get("/metrics").expect(200);
    expect(res.text).toContain('route="/api/appointments/:id"');
    expect(res.text).toContain("appointments_booked_total");
  });

  test("counts bookings", async () => {
    const fresh = createApp({ db: openDb(), now: () => new Date("2026-11-01T00:00:00Z") });
    await request(fresh)
      .post("/api/appointments")
      .send({ doctorId: 1, patientName: "A B", phone: "1234567", date: "2026-11-02", time: "09:00" })
      .expect(201);
    const res = await request(fresh).get("/metrics");
    expect(res.text).toMatch(/appointments_booked_total 1/);
  });

  test("unknown routes return a JSON 404", async () => {
    const res = await request(app).get("/nope").expect(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});

describe("fault injection", () => {
  test("fails /api requests at the configured rate but keeps health green", async () => {
    const app = createApp({ db: openDb(), chaos: { errorRate: 1 } });
    const res = await request(app).get("/api/doctors").expect(500);
    expect(res.body.error.code).toBe("INJECTED_FAILURE");
    await request(app).get("/health").expect(200);
  });

  test("passes requests when the random draw is above the rate", async () => {
    const app = createApp({ db: openDb(), chaos: { errorRate: 0.5 }, random: () => 0.9 });
    await request(app).get("/api/doctors").expect(200);
  });

  test("adds latency", async () => {
    const app = createApp({ db: openDb(), chaos: { latencyMs: 120 } });
    const start = Date.now();
    await request(app).get("/api/doctors").expect(200);
    expect(Date.now() - start).toBeGreaterThanOrEqual(100);
  });
});
