/**
 * First-run wizard. Five steps:
 *
 *   1. Welcome           — value prop + intent
 *   2. Knowledge base    — scaffold ~/kb with README + system stubs
 *   3. Connect provider  — Claude / ChatGPT OAuth, or OpenRouter API key
 *   4. Auto-start prompt — write start.md + set OMP_DECK_AUTO_START
 *   5. Done              — handoff to chat
 *
 * Every step is skippable; the wizard is escapable (top-right "Skip
 * setup" link nav to /). On any kind of completion (walked through OR
 * X-ed out) the server-side flag is written so we don't retrigger.
 *
 * Each step renders a tick when its work is already done (provider
 * already authed, kb root already exists, etc.) so re-running the
 * wizard manually from Settings doesn't pester.
 */
import { useEffect, useState } from "react";
import { BookOpen, CheckCircle2, ChevronRight, ExternalLink, KeyRound, Loader2, Sparkles, X } from "lucide-react";
import { useNavigate } from "react-router-dom";

import type { OnboardingState } from "@omp-deck/protocol";

import { OAuthFlowModal } from "@/components/settings/OAuthFlowModal";
import { Button } from "@/components/ui/Button";
import { authApi } from "@/lib/auth-api";
import { onboardingApi } from "@/lib/onboarding-api";
import { settingsApi } from "@/lib/settings-api";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

type StepKey = "welcome" | "kb" | "provider" | "autostart" | "done";

const STEP_ORDER: ReadonlyArray<{ key: StepKey; title: string }> = [
	{ key: "welcome", title: "Welcome" },
	{ key: "kb", title: "Knowledge base" },
	{ key: "provider", title: "Connect provider" },
	{ key: "autostart", title: "Session greeting" },
	{ key: "done", title: "All set" },
];

export function OnboardingView() {
	const navigate = useNavigate();
	const [state, setState] = useState<OnboardingState | null>(null);
	const [step, setStep] = useState<StepKey>("welcome");
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		void onboardingApi
			.state()
			.then(setState)
			.catch((err) => setError(err instanceof Error ? err.message : String(err)));
	}, []);

	async function refresh(): Promise<void> {
		try {
			setState(await onboardingApi.state());
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	async function finish(skipped: boolean): Promise<void> {
		try {
			await onboardingApi.complete(skipped);
			// Mark the toast trigger so a one-time hint shows up in the chat
			// view explaining how to re-run onboarding from Settings.
			if (skipped) {
				localStorage.setItem("omp-deck:onboarding-skip-toast-pending", "1");
			}
			navigate("/");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	if (error) {
		return (
			<div className="flex h-screen items-center justify-center bg-paper">
				<div className="max-w-md rounded border border-danger/40 bg-danger/5 p-4 text-sm text-danger">
					Onboarding failed to load: {error}
				</div>
			</div>
		);
	}
	if (!state) {
		return (
			<div className="flex h-screen items-center justify-center bg-paper">
				<Loader2 className="h-6 w-6 animate-spin text-ink-3" />
			</div>
		);
	}

	const stepIndex = STEP_ORDER.findIndex((s) => s.key === step);
	function go(next: StepKey): void {
		setStep(next);
	}
	function next(): void {
		const idx = STEP_ORDER.findIndex((s) => s.key === step);
		if (idx < STEP_ORDER.length - 1) {
			setStep(STEP_ORDER[idx + 1]!.key);
		}
	}

	return (
		<div className="flex h-screen flex-col bg-paper">
			{/* Top chrome — progress + escape hatch */}
			<header className="flex items-center justify-between border-b border-line px-6 py-3">
				<div className="flex items-center gap-3">
					<div className="meta text-ink-3">omp·deck onboarding</div>
					<ol className="flex items-center gap-1.5">
						{STEP_ORDER.map((s, i) => (
							<li
								key={s.key}
								className={cn(
									"flex items-center gap-1.5 text-2xs font-mono uppercase tracking-meta",
									i === stepIndex
										? "text-accent"
										: i < stepIndex
											? "text-ink-2"
											: "text-ink-4",
								)}
							>
								<span
									className={cn(
										"inline-flex h-4 w-4 items-center justify-center rounded-full border text-[10px]",
										i === stepIndex
											? "border-accent bg-accent/10 text-accent"
											: i < stepIndex
												? "border-ink-3 bg-ink-3/10 text-ink-2"
												: "border-line text-ink-4",
									)}
								>
									{i + 1}
								</span>
								<span className="hidden sm:inline">{s.title}</span>
							</li>
						))}
					</ol>
				</div>
				<button
					type="button"
					onClick={() => void finish(true)}
					className="flex items-center gap-1 text-xs text-ink-3 hover:text-ink"
					title="Mark onboarding done and go straight to the deck"
				>
					Skip setup <X className="h-3.5 w-3.5" />
				</button>
			</header>

			{/* Step body */}
			<main className="flex-1 overflow-y-auto px-6 py-10">
				<div className="mx-auto w-full max-w-xl">
					{step === "welcome" ? <Step1Welcome onNext={next} /> : null}
					{step === "kb" ? <Step2Kb state={state} onRefresh={refresh} onNext={next} /> : null}
					{step === "provider" ? (
						<Step3Provider state={state} onRefresh={refresh} onNext={next} />
					) : null}
					{step === "autostart" ? (
						<Step4AutoStart state={state} onRefresh={refresh} onNext={next} />
					) : null}
					{step === "done" ? <Step5Done onFinish={() => void finish(false)} /> : null}
				</div>
			</main>
		</div>
	);
}

// ─── Step 1: Welcome ────────────────────────────────────────────────────────

function Step1Welcome({ onNext }: { onNext: () => void }) {
	return (
		<div className="flex flex-col gap-5">
			<div>
				<h1 className="text-2xl font-semibold text-ink">Welcome to omp·deck</h1>
				<p className="mt-2 text-sm text-ink-2">
					A local cockpit for your AI coding agent — multi-session chat, kanban,
					routines, knowledge base, all loopback-only on this machine.
				</p>
			</div>
			<div className="rounded border border-line bg-paper-2 p-4 text-sm text-ink-2">
				<p>The next few steps will:</p>
				<ul className="mt-2 space-y-1.5 text-xs text-ink-3">
					<li className="flex items-start gap-2">
						<BookOpen className="mt-px h-3.5 w-3.5 shrink-0 text-ink-3" />
						<span>Scaffold a knowledge base the agent can read from</span>
					</li>
					<li className="flex items-start gap-2">
						<KeyRound className="mt-px h-3.5 w-3.5 shrink-0 text-ink-3" />
						<span>Connect a model provider so chat actually works</span>
					</li>
					<li className="flex items-start gap-2">
						<Sparkles className="mt-px h-3.5 w-3.5 shrink-0 text-ink-3" />
						<span>Optionally enable an auto-greeting on every new session</span>
					</li>
				</ul>
				<p className="mt-3 text-2xs text-ink-3">
					Each step is skippable — you can re-run this wizard any time from
					Settings → Onboarding.
				</p>
			</div>
			<div className="flex justify-end">
				<Button onClick={onNext}>
					Get started <ChevronRight className="ml-1 h-4 w-4" />
				</Button>
			</div>
		</div>
	);
}

// ─── Step 2: Knowledge base ─────────────────────────────────────────────────

function Step2Kb({
	state,
	onRefresh,
	onNext,
}: {
	state: OnboardingState;
	onRefresh: () => Promise<void>;
	onNext: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const [seeded, setSeeded] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [pathValue, setPathValue] = useState(state.kbRoot);
	const [editing, setEditing] = useState(false);

	const alreadyExists = state.kbExists;
	const pathChanged = pathValue.trim() !== state.kbRoot;

	async function scaffold(): Promise<void> {
		setBusy(true);
		setError(null);
		try {
			const target = pathValue.trim() || state.kbRoot;
			// Seed README + system/ stubs at the user-provided path. The endpoint
			// is idempotent on existing files. We deliberately don't call
			// /api/kb/init because that only writes to the SERVER's resolved
			// `OMP_DECK_KB_ROOT` — ignoring whatever the user just typed.
			await onboardingApi.seedKbSystem(target);
			// Persist the choice so the next server restart picks it up. Without
			// this the kb watcher / indexer keeps pointing at the old root and
			// the /kb tab looks empty until manual env edit.
			if (pathChanged) {
				await settingsApi.patchEnv({ OMP_DECK_KB_ROOT: target });
			}
			setSeeded(true);
			await onRefresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="flex flex-col gap-5">
			<div>
				<h1 className="text-xl font-semibold text-ink">Knowledge base</h1>
				<p className="mt-2 text-sm text-ink-2">
					omp·deck's <code className="font-mono">/kb</code> view is a
					plaintext-portable wiki the agent reads and writes. Set one up now and
					the agent has somewhere to put long-term memory.
				</p>
			</div>

			<div className="rounded border border-line bg-paper-2 p-4">
				<div className="meta mb-1.5 text-ink-3">Location</div>
				{editing ? (
					<input
						type="text"
						value={pathValue}
						onChange={(e) => setPathValue(e.target.value)}
						placeholder={state.kbRoot}
						className="field h-8 w-full px-2 font-mono text-xs"
						spellCheck={false}
						autoFocus
					/>
				) : (
					<div className="flex items-center justify-between gap-2">
						<div className="break-all font-mono text-sm text-ink">{pathValue || state.kbRoot}</div>
						<button
							type="button"
							onClick={() => setEditing(true)}
							className="shrink-0 text-2xs text-ink-3 hover:text-ink"
						>
							Change…
						</button>
					</div>
				)}
				<div className="mt-2 text-2xs text-ink-3">
					{alreadyExists && !pathChanged
						? "Already exists — scaffold will add starter files only if missing."
						: "Will be created with a README and system/ stubs the agent reads at session start."}
					{pathChanged ? (
						<span className="ml-1 text-warn">
							Path differs from server's resolved root; takes full effect after deck restart.
						</span>
					) : null}
				</div>
			</div>

			{error ? (
				<div className="rounded border border-danger/40 bg-danger/5 p-3 text-xs text-danger">
					{error}
				</div>
			) : null}

			<div className="flex items-center justify-between">
				<button
					type="button"
					onClick={onNext}
					className="text-xs text-ink-3 hover:text-ink"
				>
					Skip this step
				</button>
				<div className="flex items-center gap-2">
					{seeded || alreadyExists ? (
						<span className="flex items-center gap-1 text-xs text-success">
							<CheckCircle2 className="h-4 w-4" /> Ready
						</span>
					) : null}
					{seeded || alreadyExists ? (
						<Button onClick={onNext}>
							Continue <ChevronRight className="ml-1 h-4 w-4" />
						</Button>
					) : (
						<Button onClick={() => void scaffold()} disabled={busy}>
							{busy ? "Scaffolding…" : "Create knowledge base"}
						</Button>
					)}
				</div>
			</div>
		</div>
	);
}

// ─── Step 3: Connect provider ───────────────────────────────────────────────

function Step3Provider({
	state,
	onRefresh,
	onNext,
}: {
	state: OnboardingState;
	onRefresh: () => Promise<void>;
	onNext: () => void;
}) {
	const [activeOAuth, setActiveOAuth] = useState<{ id: string; name: string } | null>(null);
	const [apiKeyValue, setApiKeyValue] = useState("");
	const [savingKey, setSavingKey] = useState(false);
	const [error, setError] = useState<string | null>(null);

	function hasProvider(id: string): boolean {
		return state.providers.some((p) => p.id === id);
	}
	const hasAnyProvider = state.providers.length > 0;

	async function saveOpenRouterKey(): Promise<void> {
		if (!apiKeyValue.trim()) return;
		setSavingKey(true);
		setError(null);
		try {
			await settingsApi.patchEnv({ OPENROUTER_API_KEY: apiKeyValue.trim() });
			setApiKeyValue("");
			await onRefresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSavingKey(false);
		}
	}

	return (
		<>
			<div className="flex flex-col gap-5">
				<div>
					<h1 className="text-xl font-semibold text-ink">Connect a provider</h1>
					<p className="mt-2 text-sm text-ink-2">
						Pick how the agent talks to a model. Subscriptions you already pay
						for (Claude Pro/Max, ChatGPT Plus/Pro) are the easiest — no API key
						to manage. OpenRouter is a pay-as-you-go alternative.
					</p>
				</div>

				<ProviderTile
					name="Claude Pro / Max"
					subtitle="OAuth subscription via claude.ai"
					connected={hasProvider("anthropic")}
					onConnect={() => setActiveOAuth({ id: "anthropic", name: "Claude Pro/Max" })}
				/>
				<ProviderTile
					name="ChatGPT Plus / Pro"
					subtitle="OAuth subscription via chatgpt.com"
					connected={hasProvider("openai-codex")}
					onConnect={() => setActiveOAuth({ id: "openai-codex", name: "ChatGPT Plus/Pro" })}
				/>

				<div className="rounded border border-line bg-paper-2 p-4">
					<div className="flex items-baseline justify-between">
						<div>
							<div className="text-sm font-medium text-ink">OpenRouter</div>
							<div className="mt-0.5 text-xs text-ink-3">
								Pay-as-you-go API key. Single account, hundreds of models.
							</div>
						</div>
						{hasProvider("openrouter") ? (
							<span className="flex items-center gap-1 text-xs text-success">
								<CheckCircle2 className="h-4 w-4" /> Connected
							</span>
						) : null}
					</div>
					<div className="mt-3 flex gap-2">
						<input
							type="password"
							value={apiKeyValue}
							onChange={(e) => setApiKeyValue(e.target.value)}
							placeholder="sk-or-v1-…"
							className="field h-8 flex-1 px-2 font-mono text-xs"
							autoComplete="off"
						/>
						<Button onClick={() => void saveOpenRouterKey()} disabled={savingKey || !apiKeyValue.trim()}>
							{savingKey ? "Saving…" : "Save key"}
						</Button>
					</div>
					<a
						href="https://openrouter.ai/keys"
						target="_blank"
						rel="noreferrer"
						className="mt-2 flex items-center gap-1 text-2xs text-ink-3 hover:text-ink"
					>
						Get a key <ExternalLink className="h-3 w-3" />
					</a>
				</div>

				<p className="text-2xs text-ink-3">
					For other providers (OpenAI direct, Anthropic API, Google, Groq, xAI,
					etc.), see <a href="/settings" className="underline">Settings → Providers</a> after onboarding.
				</p>

				{error ? (
					<div className="rounded border border-danger/40 bg-danger/5 p-3 text-xs text-danger">
						{error}
					</div>
				) : null}

				<div className="flex items-center justify-between">
					<button
						type="button"
						onClick={onNext}
						className="text-xs text-ink-3 hover:text-ink"
					>
						Skip — I'll connect later
					</button>
					<Button onClick={onNext} disabled={!hasAnyProvider}>
						Continue <ChevronRight className="ml-1 h-4 w-4" />
					</Button>
				</div>
			</div>

			<OAuthFlowModal
				open={activeOAuth !== null}
				provider={activeOAuth?.id ?? null}
				providerName={activeOAuth?.name ?? null}
				onClose={() => setActiveOAuth(null)}
				onComplete={() => {
					setActiveOAuth(null);
					void onRefresh();
				}}
			/>
		</>
	);
}

function ProviderTile({
	name,
	subtitle,
	connected,
	onConnect,
}: {
	name: string;
	subtitle: string;
	connected: boolean;
	onConnect: () => void;
}) {
	return (
		<div className="flex items-center justify-between rounded border border-line bg-paper-2 p-4">
			<div>
				<div className="text-sm font-medium text-ink">{name}</div>
				<div className="mt-0.5 text-xs text-ink-3">{subtitle}</div>
			</div>
			{connected ? (
				<span className="flex items-center gap-1 text-xs text-success">
					<CheckCircle2 className="h-4 w-4" /> Connected
				</span>
			) : (
				<Button variant="ghost" onClick={onConnect}>
					Sign in
				</Button>
			)}
		</div>
	);
}

// ─── Step 4: Auto-start prompt ──────────────────────────────────────────────

function Step4AutoStart({
	state,
	onRefresh,
	onNext,
}: {
	state: OnboardingState;
	onRefresh: () => Promise<void>;
	onNext: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const [enabled, setEnabled] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const alreadyExists = state.startCommandExists;

	async function enable(): Promise<void> {
		setBusy(true);
		setError(null);
		try {
			// Write start.md
			const res = await fetch("/api/orientation/start", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					description: "Orient on the current workspace and capabilities",
					body: DEFAULT_START_BODY,
				}),
			});
			if (!res.ok) throw new Error(`start.md write failed: ${res.status}`);
			// Flip OMP_DECK_AUTO_START on
			await settingsApi.patchEnv({ OMP_DECK_AUTO_START: "/start" });
			setEnabled(true);
			await onRefresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="flex flex-col gap-5">
			<div>
				<h1 className="text-xl font-semibold text-ink">Session greeting</h1>
				<p className="mt-2 text-sm text-ink-2">
					When you start a new chat, the agent can automatically read your
					knowledge base, query the local API for open tasks / inbox / routines,
					and summarize where you are. Fires once per session.
				</p>
			</div>

			<details className="rounded border border-line bg-paper-2 p-4">
				<summary className="cursor-pointer text-xs text-ink-2">
					Preview what the agent will do on each new session
				</summary>
				<pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-paper p-2 font-mono text-2xs text-ink-2">
					{DEFAULT_START_BODY}
				</pre>
			</details>

			{error ? (
				<div className="rounded border border-danger/40 bg-danger/5 p-3 text-xs text-danger">
					{error}
				</div>
			) : null}

			<div className="flex items-center justify-between">
				<button
					type="button"
					onClick={onNext}
					className="text-xs text-ink-3 hover:text-ink"
				>
					Skip — empty composer is fine
				</button>
				<div className="flex items-center gap-2">
					{enabled || alreadyExists ? (
						<span className="flex items-center gap-1 text-xs text-success">
							<CheckCircle2 className="h-4 w-4" /> Enabled
						</span>
					) : null}
					{enabled || alreadyExists ? (
						<Button onClick={onNext}>
							Continue <ChevronRight className="ml-1 h-4 w-4" />
						</Button>
					) : (
						<Button onClick={() => void enable()} disabled={busy}>
							{busy ? "Enabling…" : "Enable auto-greeting"}
						</Button>
					)}
				</div>
			</div>
		</div>
	);
}

// ─── Step 5: Done ───────────────────────────────────────────────────────────

function Step5Done({ onFinish }: { onFinish: () => void }) {
	const createSession = useStore((s) => s.createSession);
	const defaultCwd = useStore((s) => s.defaultCwd);

	function openChat(): void {
		// Fire-and-forget session creation; navigation happens immediately so
		// the user is never blocked waiting on the SDK. If session creation
		// fails (e.g. no model picked yet, no auth), ChatView's SessionPicker
		// handles the empty state cleanly — the user has a path forward
		// either way.
		if (defaultCwd) {
			void createSession({ cwd: defaultCwd }).catch(() => {
				/* SessionPicker on the chat view will let the user retry */
			});
		}
		onFinish();
	}

	return (
		<div className="flex flex-col gap-5">
			<div>
				<h1 className="text-xl font-semibold text-ink">You're set up</h1>
				<p className="mt-2 text-sm text-ink-2">
					Your deck has a <code className="font-mono">T-1 Welcome</code> task in
					the kanban walking through all the surfaces. Open it any time from the
					Tasks tab.
				</p>
			</div>
			<div className="rounded border border-line bg-paper-2 p-4 text-xs text-ink-3">
				<p>What's next:</p>
				<ul className="mt-2 list-disc space-y-1 pl-4">
					<li>Send a prompt in chat to test your provider connection.</li>
					<li>Tab to <strong>Tasks</strong> and read <strong>T-1</strong> for a deeper tour.</li>
					<li>
						Visit <a href="/marketplace" className="underline">Marketplace</a>{" "}
						to install plugins / skills (recommended: claude-plugins-official).
					</li>
				</ul>
			</div>
			<div className="flex justify-end">
				<Button onClick={openChat}>
					Open chat <ChevronRight className="ml-1 h-4 w-4" />
				</Button>
			</div>
		</div>
	);
}

// ─── Default start.md body ──────────────────────────────────────────────────

/**
 * Static template — the agent re-fetches live state from the local API on
 * every fire, so this stays accurate as the deck grows (new tasks, new
 * routines, new inbox items). Users can edit the file directly afterwards.
 */
const DEFAULT_START_BODY = `You are starting a new session inside omp-deck. Before responding to the user:

1. **Read your context.** Fetch these kb files in parallel (skip any that 404):
   - \`kb://system/working-voice.md\` — how the user prefers to communicate
   - \`kb://system/deck-orientation.md\` — deck capabilities and patterns
   - \`kb://system/projects-hub.md\` — active projects
   - \`kb://system/org-system-hub.md\` — broader org context

2. **Enumerate live workspace state.** From bash, in parallel:
   - \`curl -s http://127.0.0.1:8787/api/tasks\` → kanban + open T-Ns
   - \`curl -s http://127.0.0.1:8787/api/routines\` → enabled schedules
   - \`curl -s "http://127.0.0.1:8787/api/inbox?includeProcessed=0"\` → unresolved captures

3. **Summarize in 4-6 lines.** Use this shape:
   - Open kanban (T-N + title)
   - Anything blocked (flag prominently)
   - Recent inbox worth reviewing
   - Top focus for this session

4. **End with** "Ready. What's next?" — then wait.

If the local API is unreachable, just greet the user and ask what they want to work on.
`;
