/**
 * Compact pill that shows the deck's current build/deploy phase. Reads
 * `deployState` from the store; falls back to a static "idle" pill when no
 * frame has arrived yet (e.g. fresh tab before the broadcast replays).
 *
 * Phase → color:
 *   idle      neutral
 *   queued    amber
 *   building  blue
 *   deploying blue
 *   verifying amber
 *   healthy   green
 *   failed    red
 */
import { useStore } from "@/lib/store";

const PHASE_COLOR: Record<string, string> = {
	idle: "bg-zinc-700 text-zinc-200",
	queued: "bg-amber-700 text-amber-100",
	building: "bg-blue-700 text-blue-100",
	deploying: "bg-blue-700 text-blue-100",
	verifying: "bg-amber-700 text-amber-100",
	healthy: "bg-emerald-700 text-emerald-100",
	failed: "bg-rose-700 text-rose-100",
};

export function DeployStatusBadge(): JSX.Element {
	const state = useStore((s) => s.deployState);
	const phase = state?.phase ?? "idle";
	const color = PHASE_COLOR[phase] ?? PHASE_COLOR.idle!;
	const tooltip = [
		phase,
		state?.triggeredBy && `by ${state.triggeredBy}`,
		state?.ref && `ref ${state.ref.slice(0, 7)}`,
		state?.error && `error: ${state.error}`,
	]
		.filter(Boolean)
		.join(" · ");

	return (
		<span
			data-testid="deploy-badge"
			className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${color}`}
			title={tooltip}
		>
			{phase}
		</span>
	);
}
