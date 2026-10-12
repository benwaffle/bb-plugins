import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "bb-plugin-claude-title",
    include: ["**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    setupFiles: ["./test-setup.ts"],
  },
});
