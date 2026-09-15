import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "bb-plugin-voice-whisper-local",
    include: ["**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    setupFiles: ["./test-setup.ts"],
  },
});
