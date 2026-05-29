import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Search, X } from "lucide-react";
import type { ModelInfo } from "@omp-deck/protocol";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

interface Props {
	open: boolean;
	sessionId: string;
	onClose: () => void;
	onPicked: (model: ModelInfo) => void;
}

/**
 * Modal for swapping the active session's model. Lists every model the SDK's
 * `ModelRegistry` knows about (built-ins + custom from `~/.omp/models.json`),
 * grouped by provider. Filtering is fuzzy over name/id/provider. Picking a
 * model fires `PATCH /api/sessions/:id { model }` and closes the modal.
 *
 * Models without configured auth are dimmed but still listed so the user can
 * see what the SDK supports — picking one surfaces the underlying error from
 * the server (typically "no auth configured for ...").
 */
export function ModelPickerModal({ open, sessionId, onClose, onPicked }: Props) {
	const [showUnauth, setShowUnauth] = useState(false);
	const [models, setModels] = useState<ModelInfo[]>([]);
	const [loading, setLoading] = useState(false);
	const [query, setQuery] = useState("");
	const [error, setError] = useState<string | undefined>();
	const [busyKey, setBusyKey] = useState<string | undefined>();
	const searchRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (!open) return;
		setLoading(true);
		setError(undefined);
		void api
			.listModels(sessionId)
			.then((resp) => setModels(resp.models))
			.catch((err) => setError(String(err)))
			.finally(() => setLoading(false));
	}, [open, sessionId]);

	useEffect(() => {
		if (!open) return;
		setQuery("");
		setShowUnauth(false);
		queueMicrotask(() => searchRef.current?.focus());
	}, [open]);

	const availableCount = useMemo(() => models.filter((m) => m.isAvailable).length, [models]);
	const totalCount = models.length;

	const grouped = useMemo(() => {
		const q = query.trim().toLowerCase();
		const base = showUnauth ? models : models.filter((m) => m.isAvailable);
		const filtered = q
			? base.filter(
					(m) =>
						m.id.toLowerCase().includes(q) ||
						m.label.toLowerCase().includes(q) ||
						m.provider.toLowerCase().includes(q),
				)
			: base;
		const byProvider = new Map<string, ModelInfo[]>();
		for (const m of filtered) {
			const list = byProvider.get(m.provider) ?? [];
			list.push(m);
			byProvider.set(m.provider, list);
		}
		// Providers carrying the active model float to the top; ties broken alpha.
		return Array.from(byProvider.entries())
			.map(([provider, items]) => ({
				provider,
				items: items.sort((a, b) => {
					if (a.isCurrent && !b.isCurrent) return -1;
					if (!a.isCurrent && b.isCurrent) return 1;
					return a.label.localeCompare(b.label);
				}),
				hasCurrent: items.some((m) => m.isCurrent),
			}))
			.sort((a, b) => {
				if (a.hasCurrent && !b.hasCurrent) return -1;
				if (!a.hasCurrent && b.hasCurrent) return 1;
				return a.provider.localeCompare(b.provider);
			});
	}, [models, query, showUnauth]);

	async function pick(model: ModelInfo): Promise<void> {
		const key = `${model.provider}/${model.id}`;
		setBusyKey(key);
		setError(undefined);
		try {
			await api.setSessionModel(sessionId, { provider: model.provider, id: model.id });
			onPicked(model);
			onClose();
		} catch (err) {
			setError(String((err as Error).message ?? err));
		} finally {
			setBusyKey(undefined);
		}
	}

	const matchCount = grouped.reduce((n, g) => n + g.items.length, 0);

	return (
		<Modal open={open} onClose={onClose} widthClass="max-w-2xl">
			<div className="flex h-11 items-center gap-2 border-b border-line px-3">
				<div className="meta">Switch model</div>
				<div className="text-xs text-ink-3">
					{loading ? "loading..." : `${matchCount} / ${showUnauth ? totalCount : availableCount}`}
				</div>
				<div className="flex-1" />
				<Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
					<X className="h-4 w-4" />
				</Button>
			</div>
			<div className="flex items-center gap-2 border-b border-line px-3 py-2">
				<div className="flex shrink-0 items-center gap-1 rounded-md border border-line bg-paper-2 p-0.5">
					<button
						type="button"
						onClick={() => setShowUnauth(false)}
						className={cn(
							"rounded px-2 py-1 font-mono text-2xs uppercase tracking-meta",
							!showUnauth ? "bg-accent-soft text-accent" : "text-ink-3 hover:text-ink",
						)}
						title="Show only models with configured auth"
					>
						Available {availableCount}
					</button>
					<button
						type="button"
						onClick={() => setShowUnauth(true)}
						className={cn(
							"rounded px-2 py-1 font-mono text-2xs uppercase tracking-meta",
							showUnauth ? "bg-accent-soft text-accent" : "text-ink-3 hover:text-ink",
						)}
						title="Include models without configured auth — picking one will fail with a helpful error"
					>
						All {totalCount}
					</button>
				</div>
				<div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-line bg-paper-2 px-2 py-1.5">
					<Search className="h-3.5 w-3.5 shrink-0 text-ink-3" />
					<input
						ref={searchRef}
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="Filter by name, id, or provider"
						className="min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-ink-4 focus:outline-none"
					/>
				</div>
			</div>
			{error ? (
				<div className="mx-3 my-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
					{error}
				</div>
			) : null}
			<div className="max-h-[60vh] overflow-y-auto">
				{loading && models.length === 0 ? (
					<div className="px-3 py-6 text-center text-sm text-ink-3">Loading models...</div>
				) : null}
				{grouped.length === 0 && !loading ? (
					<div className="px-3 py-6 text-center text-sm text-ink-3">No matching models.</div>
				) : null}
				{grouped.map((g) => (
					<div key={g.provider} className="border-b border-line last:border-b-0">
						<div className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-paper-2 px-3 py-1.5">
							<div className="meta">{g.provider}</div>
							<div className="text-2xs text-ink-3">{g.items.length}</div>
						</div>
						<ul>
							{g.items.map((model) => {
								const key = `${model.provider}/${model.id}`;
								const busy = busyKey === key;
								return (
									<li key={key}>
										<button
											type="button"
											disabled={busy}
											onClick={() => void pick(model)}
											className={cn(
												"flex w-full items-center gap-3 px-3 py-2 text-left transition-colors",
												model.isCurrent ? "bg-accent-soft/40" : "hover:bg-paper-3/60",
												!model.isAvailable && "opacity-60",
											)}
										>
											<div className="min-w-0 flex-1">
												<div className="flex items-center gap-2">
													<span
														className={cn(
															"truncate text-sm font-medium",
															model.isCurrent ? "text-accent" : "text-ink",
														)}
													>
														{model.label}
													</span>
													{model.isCurrent ? <Badge tone="accent">active</Badge> : null}
													{model.isSubscription ? (
														<Badge tone="success" title="Subscription provider — uses OAuth, no API key required">
															subscription
														</Badge>
													) : null}
													{!model.isAvailable ? <Badge tone="warn">no auth</Badge> : null}
												</div>
												<div className="mt-0.5 flex flex-wrap gap-2 text-2xs text-ink-3">
													<span className="font-mono">{model.id}</span>
													{model.contextWindow ? (
														<span className="font-mono">ctx {formatContext(model.contextWindow)}</span>
													) : null}
													{model.inputModes?.includes("image") ? <span>vision</span> : null}
												</div>
											</div>
											{model.isCurrent ? <Check className="h-4 w-4 shrink-0 text-accent" /> : null}
										</button>
									</li>
								);
							})}
						</ul>
					</div>
				))}
			</div>
		</Modal>
	);
}

function formatContext(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
	return String(tokens);
}
