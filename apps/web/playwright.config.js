import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:3000",
    headless: true,
    channel: process.env.PLAYWRIGHT_CHANNEL || "chrome",
  },
  webServer: [
    {
      command: "npm run dev",
      cwd: "../api",
      port: 4000,
      reuseExistingServer: true,
      env: {
        ...process.env,
        PORT: "4000",
        DSM_DEV_LOGIN: "1",
        ALLOWED_ORIGINS: "http://127.0.0.1:3000,http://localhost:3000",
      },
    },
    {
      command: "npm run dev",
      cwd: ".",
      port: 3000,
      reuseExistingServer: true,
      env: {
        ...process.env,
        PORT: "3000",
      },
    },
  ],
});
