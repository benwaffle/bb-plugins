import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "bb-plugin-telecom-ref",
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
