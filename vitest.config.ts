import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Unit and property tests for the isomorphic and server-only logic.
 *
 * Node environment only: nothing here touches the DOM, Prisma, Clerk, or the
 * network, so the suite runs offline and is unaffected by Neon cold starts.
 *
 * The `@/` alias is declared inline rather than through `vite-tsconfig-paths`,
 * which is ESM-only and cannot be required from this project's CJS config.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` throws on import outside a Server Component. The guard is
      // wanted in the build and unhelpful in a Node test runner, so it is
      // replaced with an empty module here only.
      "server-only": fileURLToPath(
        new URL("./src/test/server-only-stub.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
