import { defineConfig } from "vitest/config";

// Git worktrees live under .worktrees/ — never pick up their copies of the suite.
export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.worktrees/**"],
  },
});
