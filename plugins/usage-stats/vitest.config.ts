import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "bb-plugin-usage-stats",
    include: ["**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    env: { TZ: "UTC" },
  },
});
