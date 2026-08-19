import { defineConfig } from "vitest/config";

export default defineConfig({
  ssr: {
    external: ["node:sqlite"],
  },
  resolve: {
    alias: [
      { find: /^node:sqlite$/, replacement: "node:sqlite" },
    ],
  },
  test: {
    server: {
      deps: {
        external: ["node:sqlite"],
      },
    },
  },
});
