import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "bb-plugin-project-emoji",
    include: ["**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
