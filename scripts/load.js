// Generates steady traffic so the Grafana dashboard has something to show.
// Usage: node scripts/load.js [baseUrl] [requestsPerSecond]
const base = process.argv[2] || "http://localhost:3000";
const rps = Number(process.argv[3] || 5);

const pick = (list) => list[Math.floor(Math.random() * list.length)];
let sent = 0;
let failed = 0;

async function once() {
  try {
    const r = Math.random();
    let res;
    if (r < 0.6) res = await fetch(`${base}/api/doctors`);
    else if (r < 0.85) res = await fetch(`${base}/api/appointments?date=2099-02-01`);
    else {
      const slots = ["09:00", "09:30", "10:00", "10:30", "11:00", "14:00", "15:30"];
      res = await fetch(`${base}/api/appointments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doctorId: pick([1, 2, 3]), patientName: "Load Test", phone: "9000000000", date: "2099-02-01", time: pick(slots) }),
      });
    }
    if (res.status >= 500) failed++;
  } catch {
    failed++;
  }
  sent++;
}

setInterval(once, 1000 / rps);
setInterval(() => console.log(`sent ${sent}, server errors ${failed}`), 5000);
console.log(`Sending ~${rps} req/s to ${base}. Ctrl+C to stop.`);
