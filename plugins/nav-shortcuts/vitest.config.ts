import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "bb-plugin-nav-shortcuts",
    include: ["**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
