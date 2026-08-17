/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Vitest config mirrors apps/web/vite.config.ts (same alias, same env
// prefixes) but swaps the runtime for jsdom and adds the jest-dom matchers
// setup file. Vitest 4 reads plugins/resolve from this file at run time.
export default defineConfig({
	plugins: [react()],
	envPrefix: ["VITE_", "OMP_DECK_"],
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
		},
	},
	test: {
		environment: "jsdom",
		setupFiles: ["./test/setup.ts"],
		// Only pick up the vitest-authored React tests here. Pre-existing
		// `*.test.ts` files in src/ use `bun:test` (they run under the root
		// `bun test` script alongside the server suite). Restricting the
		// include to .tsx keeps them in the bun lane.
		include: ["src/**/*.{test,spec}.{tsx,ts}"],
		exclude: ["src/**/*.test.ts", "node_modules/**", "dist/**"],
		globals: false,
		// `bun run test` exits 0 even before WS-D lands the React tests.
		passWithNoTests: true,
	},
});
