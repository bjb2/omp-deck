import { useEffect, useMemo, useState } from "react";
import { Loader2, Wrench, X } from "lucide-react";
import { useStore, fetchMcpTools } from "@/lib/store";
import { storefrontApi } from "@/lib/storefront-api";
import { cn } from "@/lib/utils";

interface Props {
	/** Server name the popover is anchored to. */
	name: string;
	/** Called when the user dismisses the popover so the parent can close. */
	onClose: () => void;
}

/**
 * Floating tool-toggler for one MCP server. Reads the cached
 * `mcpToolsByName[name]` (hydrated by `fetchMcpTools` on first open) and
 * subscribes to `mcpToolsChangeCounter` so any `mcp_tools_changed` frame
 * for *any* server triggers a refetch — the per-server mutation is
 * rare, and the popover mounts briefly so a blanket subscribe is fine.
 */
export function McpToolsPopover({ name, onClose }: Props) {
	const cached = useStore((s) => s.mcpToolsByName[name]);
	const counter = useStore((s) => s.mcpToolsChangeCounter);
	const [busyTool, setBusyTool] = useState<string | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setLoadError(null);
		void fetchMcpTools(name).then((res) => {
			if (cancelled) return;
			if (!res) setLoadError("Could not load tools.");
		});
		return () => {
			cancelled = true;
		};
	}, [name, counter]);

	const disabled = useMemo(() => new Set(cached?.disabledTools ?? []), [cached]);

	async function toggle(tool: string, next: boolean): Promise<void> {
		setBusyTool(tool);
		try {
			await storefrontApi.toggleMcpTool(name, tool, next);
			// The server broadcasts `mcp_tools_changed` after a successful
			// write, which evicts our cached entry and re-runs the effect
			// above. No local state mutation needed.
		} catch {
			// The api wrapper swallows fetch errors, so this only fires for
			// genuinely unexpected throws; the popover just stops spinning.
		} finally {
			setBusyTool(null);
		}
	}

	return (
		<div
			role="dialog"
			aria-label={`Tools for ${name}`}
			className="flex w-80 max-w-[90vw] flex-col rounded-md border border-line bg-paper shadow-lg"
		>
			<header className="flex items-center gap-2 border-b border-line px-3 py-2">
				<Wrench className="h-3.5 w-3.5 text-ink-3" />
				<span className="font-mono text-2xs uppercase tracking-meta text-ink-3">
					{name} tools
				</span>
				<button
					type="button"
					onClick={onClose}
					className="ml-auto btn-ghost h-6 w-6 p-0"
					aria-label="Close tools"
				>
					<X className="h-3.5 w-3.5" />
				</button>
			</header>
			<div className="max-h-72 overflow-y-auto px-1 py-1">
				{loadError ? (
					<div className="px-2 py-3 text-2xs text-danger">{loadError}</div>
				) : !cached ? (
					<div className="flex items-center gap-2 px-2 py-3 font-mono text-2xs text-ink-3">
						<Loader2 className="h-3 w-3 animate-spin" />
						loading tools…
					</div>
				) : cached.tools.length === 0 ? (
					<div className="px-2 py-3 text-2xs text-ink-3">
						This server advertises no tools.
					</div>
				) : (
					cached.tools.map((t) => {
						const isDisabled = disabled.has(t.name);
						const isBusy = busyTool === t.name;
						return (
							<label
								key={t.name}
								className={cn(
									"flex items-start gap-2 rounded px-2 py-1.5 hover:bg-paper-2",
									isBusy && "opacity-60",
								)}
							>
								<input
									type="checkbox"
									className="mt-0.5"
									checked={!isDisabled}
									disabled={isBusy}
									onChange={(e) => void toggle(t.name, e.target.checked)}
								/>
								<span className="flex min-w-0 flex-col">
									<span className="font-mono text-2xs text-ink">{t.name}</span>
									{t.description ? (
										<span className="text-2xs text-ink-3">{t.description}</span>
									) : null}
								</span>
								{isBusy ? (
									<Loader2 className="ml-auto h-3 w-3 animate-spin text-ink-3" />
								) : null}
							</label>
						);
					})
				)}
			</div>
		</div>
	);
}