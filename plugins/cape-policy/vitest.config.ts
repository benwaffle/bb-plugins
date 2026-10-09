import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "bb-plugin-cape-policy",
    include: ["**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
