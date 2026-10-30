const client = require("prom-client");

// One registry per app instance, so tests can create apps freely.
function createMetrics() {
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });

  const httpDuration = new client.Histogram({
    name: "http_request_duration_seconds",
    help: "HTTP request duration in seconds",
    labelNames: ["method", "route", "status_code"],
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [registry],
  });

  const bookings = new client.Counter({
    name: "appointments_booked_total",
    help: "Appointments booked",
    registers: [registry],
  });

  // Label by route pattern (/api/appointments/:id), not raw URL, to keep cardinality low.
  // Express resets req.baseUrl once a router is done, so routers record their
  // mount path with `captureMount` while the request is still inside them.
  function middleware(req, res, next) {
    const end = httpDuration.startTimer();
    res.on("finish", () => {
      const route = req.route ? (res.locals.mountPath || "") + req.route.path : "unmatched";
      end({ method: req.method, route, status_code: res.statusCode });
    });
    next();
  }

  function captureMount(req, res, next) {
    res.locals.mountPath = req.baseUrl;
    next();
  }

  return { registry, middleware, captureMount, bookings };
}

module.exports = { createMetrics };
