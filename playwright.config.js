const { defineConfig } = require("@playwright/test");

// API-only tests: no browsers are needed.
module.exports = defineConfig({
  testDir: "tests/smoke",
  timeout: 30_000,
  // A release gate should not hide flakiness behind retries.
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: process.env.BASE_URL || "http://localhost:3000",
    extraHTTPHeaders: { "User-Agent": "release-guard-smoke" },
  },
});
