const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests/e2e",
  timeout: 30000,
  expect: { timeout: 10000 },
  reporter: [["line"], ["json", { outputFile: "test-results/report.json" }],],
  use: {
    baseURL: "http://127.0.0.1:8765",
    headless: true,
    trace: "retain-on-failure"
  },
  webServer: {
    command: "python -m http.server 8765 --directory dashboard",
    url: "http://127.0.0.1:8765/trading.html",
    reuseExistingServer: !process.env.CI,
    timeout: 15000
  }
});
