const request = require("supertest");
const { createApp } = require("../../src/app");
const { openDb } = require("../../src/db");
const { assertContract } = require("../contract");

const NOW = new Date("2026-11-01T08:00:00Z");
const booking = (over = {}) => ({
  doctorId: 1,
  patientName: "Test Patient",
  phone: "+91 98765 43210",
  date: "2026-11-05",
  time: "10:30",
  ...over,
});

let app;
beforeEach(() => {
  app = createApp({ db: openDb(), now: () => NOW });
});

describe("doctors and slots", () => {
  test("lists seeded doctors", async () => {
    const res = await request(app).get("/api/doctors").expect(200);
    expect(res.body.length).toBeGreaterThan(0);
    assertContract("/api/doctors", "get", 200, res.body);
  });

  test("lists 30-minute slots from 09:00 to 16:30", async () => {
    const res = await request(app).get("/api/slots").expect(200);
    expect(res.body[0]).toBe("09:00");
    expect(res.body.at(-1)).toBe("16:30");
    assertContract("/api/slots", "get", 200, res.body);
  });
});

describe("booking", () => {
  test("books an appointment and returns it with a Location header", async () => {
    const res = await request(app).post("/api/appointments").send(booking()).expect(201);
    assertContract("/api/appointments", "post", 201, res.body);
    expect(res.body).toMatchObject({ doctorId: 1, date: "2026-11-05", time: "10:30", status: "booked" });
    expect(res.headers.location).toBe(`/api/appointments/${res.body.id}`);

    const fetched = await request(app).get(res.headers.location).expect(200);
    assertContract("/api/appointments/{id}", "get", 200, fetched.body);
    expect(fetched.body).toEqual(res.body);
  });

  test("rejects a second booking for the same doctor and slot", async () => {
    await request(app).post("/api/appointments").send(booking()).expect(201);
    const res = await request(app).post("/api/appointments").send(booking({ patientName: "Someone Else" })).expect(409);
    assertContract("/api/appointments", "post", 409, res.body);
    expect(res.body.error.code).toBe("SLOT_TAKEN");
  });

  test("allows the same slot with a different doctor", async () => {
    await request(app).post("/api/appointments").send(booking()).expect(201);
    await request(app).post("/api/appointments").send(booking({ doctorId: 2 })).expect(201);
  });

  test("frees the slot again after cancelling", async () => {
    const first = await request(app).post("/api/appointments").send(booking()).expect(201);
    const cancelled = await request(app).patch(`/api/appointments/${first.body.id}`).send({ status: "cancelled" }).expect(200);
    assertContract("/api/appointments/{id}", "patch", 200, cancelled.body);
    expect(cancelled.body.status).toBe("cancelled");
    await request(app).post("/api/appointments").send(booking()).expect(201);
  });

  test("returns 404 for an unknown doctor", async () => {
    const res = await request(app).post("/api/appointments").send(booking({ doctorId: 999 })).expect(404);
    expect(res.body.error.code).toBe("DOCTOR_NOT_FOUND");
  });
});

describe("validation", () => {
  test.each([
    ["missing fields", { doctorId: 1 }, ["patientName", "phone", "date", "time"]],
    ["time outside slots", booking({ time: "10:15" }), ["time"]],
    ["past date", booking({ date: "2026-10-31" }), ["date"]],
    ["impossible date", booking({ date: "2026-13-40" }), ["date"]],
    ["bad phone", booking({ phone: "call me" }), ["phone"]],
    ["unknown field", { ...booking(), discount: 50 }, [""]],
  ])("rejects %s with field details", async (_name, body, paths) => {
    const res = await request(app).post("/api/appointments").send(body).expect(400);
    assertContract("/api/appointments", "post", 400, res.body);
    expect(res.body.error.code).toBe("VALIDATION_FAILED");
    const reported = res.body.error.details.map((d) => d.path);
    for (const p of paths) expect(reported).toContain(p);
  });

  test("rejects malformed JSON", async () => {
    const res = await request(app).post("/api/appointments").set("Content-Type", "application/json").send("{bad").expect(400);
    expect(res.body.error.code).toBe("INVALID_JSON");
  });

  test("rejects a status other than cancelled", async () => {
    const created = await request(app).post("/api/appointments").send(booking()).expect(201);
    await request(app).patch(`/api/appointments/${created.body.id}`).send({ status: "booked" }).expect(400);
  });
});

describe("lookup and listing", () => {
  test.each(["9999", "abc"])("returns 404 for appointment id %s", async (id) => {
    const res = await request(app).get(`/api/appointments/${id}`).expect(404);
    assertContract("/api/appointments/{id}", "get", 404, res.body);
  });

  test("filters by doctor and date", async () => {
    await request(app).post("/api/appointments").send(booking()).expect(201);
    await request(app).post("/api/appointments").send(booking({ doctorId: 2 })).expect(201);
    await request(app).post("/api/appointments").send(booking({ date: "2026-11-06" })).expect(201);

    const res = await request(app).get("/api/appointments?doctorId=1&date=2026-11-05").expect(200);
    assertContract("/api/appointments", "get", 200, res.body);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ doctorId: 1, date: "2026-11-05" });
  });

  test("rejects an invalid filter", async () => {
    await request(app).get("/api/appointments?date=tomorrow").expect(400);
  });
});
