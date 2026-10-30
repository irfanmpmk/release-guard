// Post-deploy smoke tests: black-box checks against a running instance.
// BASE_URL         where the release is running (default http://localhost:3000)
// EXPECTED_COMMIT  if set, the instance must report this commit
// LATENCY_BUDGET_MS  p95 budget for a simple read (default 500)
const { test, expect } = require("@playwright/test");
const { assertContract } = require("../contract");

const EXPECTED_COMMIT = process.env.EXPECTED_COMMIT;
const LATENCY_BUDGET_MS = Number(process.env.LATENCY_BUDGET_MS || 500);

test("is live and ready", async ({ request }) => {
  const health = await request.get("/health");
  expect(health.status()).toBe(200);
  const ready = await request.get("/ready");
  expect(ready.status()).toBe(200);
});

test("runs the expected release", async ({ request }) => {
  test.skip(!EXPECTED_COMMIT, "EXPECTED_COMMIT not set");
  const res = await request.get("/version");
  expect(res.status()).toBe(200);
  const body = await res.json();
  assertContract("/version", "get", 200, body);
  expect(body.commit).toBe(EXPECTED_COMMIT);
});

test("serves doctors within the contract", async ({ request }) => {
  const res = await request.get("/api/doctors");
  expect(res.status()).toBe(200);
  const body = await res.json();
  assertContract("/api/doctors", "get", 200, body);
  expect(body.length).toBeGreaterThan(0);
});

test("books, reads and cancels an appointment", async ({ request }) => {
  const [doctor] = await (await request.get("/api/doctors")).json();
  const slots = await (await request.get("/api/slots")).json();

  // A far-future date keeps smoke bookings away from real ones; retry if a slot is taken.
  let created;
  for (let attempt = 0; attempt < 5 && !created; attempt++) {
    const day = String(1 + Math.floor(Math.random() * 28)).padStart(2, "0");
    const res = await request.post("/api/appointments", {
      data: {
        doctorId: doctor.id,
        patientName: "Smoke Test",
        phone: "+91 90000 00000",
        date: `2099-01-${day}`,
        time: slots[Math.floor(Math.random() * slots.length)],
      },
    });
    if (res.status() === 409) continue;
    expect(res.status()).toBe(201);
    created = await res.json();
    assertContract("/api/appointments", "post", 201, created);
  }
  expect(created, "could not find a free slot").toBeTruthy();

  const fetched = await request.get(`/api/appointments/${created.id}`);
  expect(await fetched.json()).toEqual(created);

  // Clean up so smoke runs don't pile up bookings.
  const cancelled = await request.patch(`/api/appointments/${created.id}`, { data: { status: "cancelled" } });
  expect(cancelled.status()).toBe(200);
  expect((await cancelled.json()).status).toBe("cancelled");
});

test(`keeps p95 read latency under ${LATENCY_BUDGET_MS} ms`, async ({ request }) => {
  const timings = [];
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    const res = await request.get("/api/doctors");
    timings.push(performance.now() - start);
    expect(res.status()).toBe(200);
  }
  timings.sort((a, b) => a - b);
  const p95 = timings[Math.ceil(timings.length * 0.95) - 1];
  expect(p95, `p95 was ${p95.toFixed(0)} ms`).toBeLessThan(LATENCY_BUDGET_MS);
});

test("exposes metrics for monitoring", async ({ request }) => {
  const res = await request.get("/metrics");
  expect(res.status()).toBe(200);
  expect(await res.text()).toContain("http_request_duration_seconds_bucket");
});
