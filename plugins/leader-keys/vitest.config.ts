import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "bb-plugin-leader-keys",
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
