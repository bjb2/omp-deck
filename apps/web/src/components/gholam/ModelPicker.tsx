/**
 * Model `<select>` for the Gholam new-chat form.
 *
 * Pulls providers from `GET /api/llm/providers` and lets the user pick
 * `provider/id`. Falls back to a free-text input when the registry request
 * fails (cold-boot, network, admin-only endpoint) so the form stays usable.
 */
import { useEffect, useState } from "react";

import { llmProvidersApi, type DeckLLMProviderSummary } from "@/lib/llm-providers-api";

interface Props {
	value: string; // "provider/id" or free-text
	onChange: (next: string) => void;
}

export function ModelPicker({ value, onChange }: Props) {
	const [providers, setProviders] = useState<DeckLLMProviderSummary[] | null>(null);
	const [error, setError] = useState<string | undefined>();

	useEffect(() => {
		let cancelled = false;
		llmProvidersApi
			.list()
			.then((res) => {
				if (cancelled) return;
				setProviders(res.providers);
			})
			.catch((err) => {
				if (cancelled) return;
				setError(String(err));
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const fallback = (
		<input
			value={value}
			onChange={(ev) => onChange(ev.target.value)}
			placeholder="provider/id"
			className="rounded border border-line bg-paper-2 px-2 py-1 font-mono text-2xs text-ink"
		/>
	);

	if (error) {
		return (
			<div className="flex flex-col gap-1">
				{fallback}
				<span className="font-mono text-2xs text-ink-3">
					provider list unavailable — type a model ref manually
				</span>
			</div>
		);
	}

	if (!providers) {
		return (
			<div className="font-mono text-2xs text-ink-3">Loading providers…</div>
		);
	}

	// No providers registered — degenerate but allow free-text submit.
	if (providers.length === 0) {
		return fallback;
	}

	return (
		<select
			value={value}
			onChange={(ev) => onChange(ev.target.value)}
			className="rounded border border-line bg-paper-2 px-2 py-1 font-mono text-2xs text-ink"
		>
			<option value="">— default —</option>
			{providers.flatMap((p) =>
				p.models.map((m) => (
					<option key={`${p.id}/${m.id}`} value={`${p.id}/${m.id}`}>
						{p.displayName} · {m.displayName}
					</option>
				)),
			)}
		</select>
	);
}
