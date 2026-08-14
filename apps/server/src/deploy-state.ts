/**
 * In-process latest-snapshot registry for `deploy_state` frames. The route
 * layer reads it via the GET handler; the routine runner (or any other
 * emitter) writes it via `setLatestDeployState()`. The broadcast publish
 * is the live channel; this is the snapshot read for a fresh tab.
 */
import type { DeployState } from "@omp-deck/protocol";
import { broadcastBus } from "./broadcast-bus.ts";

let latestDeployState: DeployState = {
	phase: "idle",
	triggeredBy: "user",
	updatedAt: new Date(0).toISOString(),
};

export function setLatestDeployState(state: DeployState): void {
	latestDeployState = state;
	broadcastBus.broadcast({ type: "deploy_state", state });
}

export function getLatestDeployState(): DeployState {
	return latestDeployState;
}
