const { DatabaseSync } = require("node:sqlite");

const DOCTORS = [
  ["Dr. Anjali Menon", "General Medicine"],
  ["Dr. Rahul Nair", "Paediatrics"],
  ["Dr. Fathima Rasheed", "Dermatology"],
];

// SQLite keeps the demo dependency-free; one booked appointment per doctor per slot
// is enforced by the database itself, so double bookings fail even under races.
function openDb(path = ":memory:") {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS doctors (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      specialty TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS appointments (
      id INTEGER PRIMARY KEY,
      doctor_id INTEGER NOT NULL REFERENCES doctors(id),
      patient_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'booked',
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_booking_per_slot
      ON appointments (doctor_id, date, time) WHERE status = 'booked';
  `);
  if (db.prepare("SELECT COUNT(*) AS n FROM doctors").get().n === 0) {
    const insert = db.prepare("INSERT INTO doctors (name, specialty) VALUES (?, ?)");
    for (const [name, specialty] of DOCTORS) insert.run(name, specialty);
  }
  return db;
}

module.exports = { openDb };
