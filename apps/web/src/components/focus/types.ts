export interface FocusSession {
	taskId: string | null;
	startedAt: number; // ms epoch
	durationMin: number;
	breakMin: number;
	phase: "focus" | "break";
}

export interface ScheduleAlert {
	routineId: string;
	routineName: string;
	cron: string;
	nextRun: string | null; // ISO
	preAlertEnabled: boolean;
}
