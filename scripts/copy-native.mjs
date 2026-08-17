#!/usr/bin/env bun
// Stage the bundled server's runtime side-files:
//   - apps/server/native/pi_natives.<plat>.node
//     (SDK native loader probes `<import.meta.dir>/../native/`)
//   - apps/server/dist/migrations/*.sql
//     (db/index.ts uses `import.meta.url` of the bundled file)
import { platform, arch } from 'node:os';
import { cpSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';

const cwd = process.cwd();
const pkg = `@oh-my-pi/pi-natives-${platform()}-${arch()}`;
const flatPrefix = pkg.replace('/', '+') + '@';

function findBunModule(start) {
	let dir = start;
	for (let i = 0; i < 6; i++) {
		const bun = join(dir, 'node_modules', '.bun');
		if (existsSync(bun)) {
			for (const entry of readdirSync(bun)) {
				if (entry.startsWith(flatPrefix)) {
					const root = join(bun, entry, 'node_modules', pkg);
					if (existsSync(join(root, 'package.json'))) return root;
				}
			}
		}
		dir = dirname(dir);
	}
	return null;
}

const nativeRoot = findBunModule(cwd);
if (nativeRoot) {
	// Probe path 1: apps/server/native/ (sibling of dist/)
	const dest1 = resolve(cwd, 'native');
	mkdirSync(dest1, { recursive: true });
	cpSync(nativeRoot, dest1, {
		recursive: true,
		filter: (s) => s.endsWith('.node') || s === nativeRoot,
	});
	console.log(`[copy-native] copied ${pkg} → native/`);
} else {
	console.warn(`[copy-native] ${pkg} not installed; skipping native`);
}

const migSrc = resolve(cwd, 'src/db/migrations');
if (existsSync(migSrc)) {
	const migDest = resolve(cwd, 'dist/migrations');
	mkdirSync(migDest, { recursive: true });
	cpSync(migSrc, migDest, { recursive: true });
	console.log(`[copy-native] copied migrations → dist/migrations/`);
}
