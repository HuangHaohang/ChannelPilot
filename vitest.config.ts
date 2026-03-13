import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@channelpilot/db": path.resolve(rootDir, "packages/db/src/index.ts"),
      "@channelpilot/domain": path.resolve(rootDir, "packages/domain/src/index.ts"),
      "@channelpilot/openclaw-adapter": path.resolve(rootDir, "packages/openclaw-adapter/src/index.ts"),
      "@channelpilot/shared-types": path.resolve(rootDir, "packages/shared-types/src/index.ts")
    }
  },
  test: {
    globals: true,
    environment: "node",
    include: ["packages/**/*.test.ts", "services/**/*.test.ts"]
  }
});
