import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "bb-plugin-pr-review",
    include: ["**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
