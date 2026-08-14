import type { ServerFrame } from "@omp-deck/protocol";

/**
 * Singleton fan-out for non-session-scoped events the deck wants every
 * connected WebSocket client to see. Producers (route handlers, deck slash
 * dispatcher, routine runner) call `broadcast(frame)`; the WS hub subscribes
 * once and relays to every open connection.
 *
 * This decouples mutation sites from transport — `routes-tasks.ts` does not
 * import the hub, and the hub does not import every route module.
 */
export type BroadcastFrame = Extract<
	ServerFrame,
	| { type: "deploy_state" }
	| { type: "tasks_changed" }
	| { type: "skills_changed" }
	| { type: "kb_changed" }
	| { type: "store_item_added" }
	| { type: "store_item_updated" }
	| { type: "store_item_removed" }
	| { type: "discovery_added" }
	| { type: "mcp_health" }
	| { type: "genui_delta" }
	| { type: "oauth_consent" }
	| { type: "oauth_progress" }
	| { type: "oauth_prompt" }
	| { type: "oauth_complete" }
	| { type: "oauth_failed" }
	| { type: "models_changed" }
	| { type: "routine_run_started" }
	| { type: "routine_step_event" }
	| { type: "routine_run_finished" }
	| { type: "heartbeat" }
	| { type: "notification" }
	| { type: "gholam_chat_message" }
	| { type: "gholam_chat_state" }
	| { type: "gholam_chat_usage" }
>;

type Listener = (frame: BroadcastFrame) => void;

class BroadcastBus {
	private listeners = new Set<Listener>();

	broadcast(frame: BroadcastFrame): void {
		for (const l of this.listeners) {
			try {
				l(frame);
			} catch {
				// One bad listener must not block the others.
			}
		}
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
}

export const broadcastBus = new BroadcastBus();
