import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Calendar, FileText, Clock } from "lucide-react";
import { Layout } from "@/components/Layout";
import { overviewApi, type ReceiptEntry } from "@/lib/overview-api";

function todayLocalDate(): string {
	const d = new Date();
	const year = d.getFullYear();
	const month = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

export function ReceiptsView() {
	const navigate = useNavigate();
	const [selectedDate, setSelectedDate] = useState<string>(todayLocalDate());
	const [receipts, setReceipts] = useState<ReceiptEntry[]>([]);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		let active = true;
		setLoading(true);
		overviewApi.receipts(selectedDate).then((res) => {
			if (active) {
				setReceipts(res.receipts ?? []);
				setLoading(false);
			}
		});
		return () => {
			active = false;
		};
	}, [selectedDate]);

	return (
		<Layout
			sidebar={null}
			inspector={null}
			main={
				<div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6 overflow-y-auto">
					<header className="flex flex-wrap items-center justify-between gap-4">
						<div className="flex items-center gap-3">
							<button
								type="button"
								onClick={() => navigate("/")}
								className="rounded-full border border-line p-2 text-ink-3 hover:text-ink hover:border-ink/30 transition-colors"
								title="Back to Overview"
							>
								<ArrowLeft className="h-4 w-4" />
							</button>
							<div>
								<div className="meta">Session Receipts</div>
								<h1 className="text-2xl font-semibold tracking-tight text-ink">
									Work Receipts & Log
								</h1>
							</div>
						</div>
						<div className="flex items-center gap-2 rounded-xl border border-line bg-paper px-3 py-1.5 text-sm text-ink-2">
							<Calendar className="h-4 w-4 text-ink-3" />
							<input
								type="date"
								value={selectedDate}
								onChange={(e) => setSelectedDate(e.target.value)}
								className="bg-transparent font-mono text-sm text-ink outline-none"
							/>
						</div>
					</header>

					{loading ? (
						<div className="flex flex-col gap-3">
							{[0, 1, 2].map((i) => (
								<div
									key={i}
									className="h-20 animate-pulse rounded-xl bg-paper-3"
								/>
							))}
						</div>
					) : receipts.length === 0 ? (
						<div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-line bg-paper px-6 py-12 text-center">
							<FileText className="h-8 w-8 text-ink-4" />
							<div className="text-base font-medium text-ink">No receipts for {selectedDate}</div>
							<p className="text-sm text-ink-3">
								Completed focus sessions automatically generate markdown receipt logs.
							</p>
						</div>
					) : (
						<div className="flex flex-col gap-3">
							{receipts.map((r) => (
								<div
									key={r.filename}
									className="flex flex-col gap-2 rounded-xl border border-line bg-paper p-4 transition-colors hover:border-ink/20"
								>
									<div className="flex items-center justify-between gap-3">
										<div className="flex items-center gap-2 font-mono text-xs text-accent">
											<FileText className="h-3.5 w-3.5" />
											<span>{r.filename}</span>
										</div>
										<div className="flex items-center gap-1 font-mono text-2xs text-ink-4">
											<Clock className="h-3 w-3" />
											<span>{new Date(r.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
										</div>
									</div>
									<div className="text-base font-medium text-ink">
										{r.goal || "Focus Session"}
									</div>
									{r.sessionId ? (
										<div className="flex items-center gap-2">
											<Link
												to={`/chat?session=${encodeURIComponent(r.sessionId)}`}
												className="font-mono text-2xs text-ink-3 hover:text-accent underline"
											>
												View Session ({r.sessionId})
											</Link>
										</div>
									) : null}
								</div>
							))}
						</div>
					)}
				</div>
			}
		/>
	);
}
