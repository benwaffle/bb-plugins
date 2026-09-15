import { createRequire } from "node:module";

const globals = globalThis as { require?: NodeJS.Require };
globals.require ??= createRequire(import.meta.url);
