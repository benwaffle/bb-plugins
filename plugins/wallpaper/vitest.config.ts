import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "bb-plugin-wallpaper",
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
