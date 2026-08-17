import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	getDefaultPrelude,
	getEffectivePrelude,
	getPreludeFilePath,
	readMaintenanceGateState,
	readPreludeOverride,
	readStartCommand,
	renderMaintenanceReminder,
	writePreludeOverride,
	writeStartCommand,
} from "./orientation-store.ts";

const ENV_KEYS = [
	"OMP_DECK_DATA_DIR",
	"OMP_DECK_MAINTENANCE_GATE_DISABLED",
	"OMP_MAINTENANCE_GATE_MIN_OP_MSGS",
	"OMP_MAINTENANCE_GATE_MIN_RELEASE_AGE_MS",
	"OMP_MAINTENANCE_GATE_FIRE_FLOOR_MS",
	"OMP_DECK_ORG_ROOT",
	"HOME",
	"USERPROFILE",
];

let saved: Record<string, string | undefined>;
let tmpDataDir: string;
let tmpHomeDir: string;

beforeEach(() => {
	saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
	tmpDataDir = mkdtempSync(path.join(os.tmpdir(), "omp-deck-orient-data-"));
	tmpHomeDir = mkdtempSync(path.join(os.tmpdir(), "omp-deck-orient-home-"));
	process.env.OMP_DECK_DATA_DIR = tmpDataDir;
	// os.homedir() honors USERPROFILE on Windows and HOME on POSIX. Override
	// both so the test never writes to the real user home no matter which
	// platform Bun picks up.
	process.env.HOME = tmpHomeDir;
	process.env.USERPROFILE = tmpHomeDir;
	for (const k of ENV_KEYS) {
		if (
			k !== "OMP_DECK_DATA_DIR" &&
			k !== "HOME" &&
			k !== "USERPROFILE"
		) {
			delete process.env[k];
		}
	}
});

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

describe("prelude override", () => {
	test("absent override falls back to the built-in prelude", () => {
		expect(readPreludeOverride()).toBeNull();
		expect(getEffectivePrelude()).toBe(getDefaultPrelude());
	});

	test("write then read round-trips verbatim", () => {
		const text = "# custom prelude\n— em-dash · middle-dot — done\n";
		writePreludeOverride(text);
		expect(readPreludeOverride()).toBe(text);
		expect(getEffectivePrelude()).toBe(text);
		// File matches verbatim on disk (no BOM, no CRLF translation).
		const onDisk = readFileSync(getPreludeFilePath(), "utf8");
		expect(onDisk).toBe(text);
	});

	test("null clears the override and removes the file", () => {
		writePreludeOverride("anything");
		expect(existsSync(getPreludeFilePath())).toBe(true);
		writePreludeOverride(null);
		expect(existsSync(getPreludeFilePath())).toBe(false);
		expect(getEffectivePrelude()).toBe(getDefaultPrelude());
	});

	test("clearing an already-absent override is a no-op", () => {
		expect(() => writePreludeOverride(null)).not.toThrow();
		expect(readPreludeOverride()).toBeNull();
	});
});

describe("start command", () => {
	test("missing file returns exists=false with empty fields", () => {
		const cmd = readStartCommand();
		expect(cmd.exists).toBe(false);
		expect(cmd.description).toBe("");
		expect(cmd.body).toBe("");
		expect(cmd.path.endsWith(path.join(".omp", "agent", "commands", "start.md"))).toBe(true);
	});

	test("write + read round-trips description and body verbatim", () => {
		const desc = "Orient — load context, then list";
		const body = "Line 1\nLine 2 with — em-dash\n";
		writeStartCommand(desc, body);
		const cmd = readStartCommand();
		expect(cmd.exists).toBe(true);
		expect(cmd.description).toBe(desc);
		expect(cmd.body).toBe(body);
	});

	test("empty description omits the frontmatter block", () => {
		writeStartCommand("", "just body content\n");
		const onDisk = readFileSync(readStartCommand().path, "utf8");
		expect(onDisk.startsWith("---")).toBe(false);
		expect(onDisk).toBe("just body content\n");
		const cmd = readStartCommand();
		expect(cmd.description).toBe("");
		expect(cmd.body).toBe("just body content\n");
	});

	test("reads existing frontmatter without description as empty", () => {
		const target = readStartCommand().path;
		const dir = path.dirname(target);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			target,
			`---\nargs: ["x"]\n---\nbody here\n`,
			{ encoding: "utf8", flag: "w" },
		);
		expect(existsSync(dir)).toBe(true);
		const cmd = readStartCommand();
		expect(cmd.description).toBe("");
		expect(cmd.body).toBe("body here\n");
	});

	test("strips surrounding quotes from a quoted description", () => {
		const target = readStartCommand().path;
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(
			target,
			`---\ndescription: "Quoted summary"\n---\nbody\n`,
			{ encoding: "utf8", flag: "w" },
		);
		expect(readStartCommand().description).toBe("Quoted summary");
	});
});

describe("maintenance gate state", () => {
	test("defaults to enabled with all knobs at compiled defaults", () => {
		const state = readMaintenanceGateState();
		expect(state.enabled).toBe(true);
		expect(state.knobs.minOpMsgs.value).toBe(4);
		expect(state.knobs.minOpMsgs.source).toBe("default");
		expect(state.knobs.minReleaseAgeMs.value).toBe(8 * 60_000);
		expect(state.knobs.fireFloorMs.value).toBe(25 * 60_000);
		expect(state.orgRoot).toBeNull();
	});

	test("OMP_DECK_MAINTENANCE_GATE_DISABLED=1 reports enabled=false", () => {
		process.env.OMP_DECK_MAINTENANCE_GATE_DISABLED = "1";
		const state = readMaintenanceGateState();
		expect(state.enabled).toBe(false);
		expect(state.disabledRaw).toBe("1");
		expect(state.disabledSource).toBe("process-env");
	});

	test("non-truthy disable values leave the gate enabled", () => {
		for (const value of ["", "0", "false", "no", "off"]) {
			process.env.OMP_DECK_MAINTENANCE_GATE_DISABLED = value;
			const state = readMaintenanceGateState();
			expect(state.enabled).toBe(true);
		}
	});

	test("knob override surfaces in value/source/raw", () => {
		process.env.OMP_MAINTENANCE_GATE_MIN_OP_MSGS = "7";
		const state = readMaintenanceGateState();
		expect(state.knobs.minOpMsgs.value).toBe(7);
		expect(state.knobs.minOpMsgs.rawValue).toBe("7");
		expect(state.knobs.minOpMsgs.source).toBe("process-env");
	});

	test("invalid knob falls back to default but keeps raw + source", () => {
		process.env.OMP_MAINTENANCE_GATE_FIRE_FLOOR_MS = "not-a-number";
		const state = readMaintenanceGateState();
		expect(state.knobs.fireFloorMs.value).toBe(25 * 60_000);
		expect(state.knobs.fireFloorMs.rawValue).toBe("not-a-number");
		expect(state.knobs.fireFloorMs.source).toBe("process-env");
	});

	test("preview tables differ across profiles in the expected places", () => {
		const deck = renderMaintenanceReminder("deck");
		const flat = renderMaintenanceReminder("flat-file");
		expect(deck).toContain("POST /api/inbox");
		expect(deck).toContain("kb://system/");
		expect(deck).not.toContain("knowledge/<subfolder>");
		expect(flat).toContain("inbox/captures/<item>.md");
		expect(flat).not.toContain("POST /api/inbox");
	});
});
