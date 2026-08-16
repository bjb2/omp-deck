import { useEffect, useState } from "react";
import { Check, Copy, RefreshCw, X } from "lucide-react";

import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { generateQrSvg } from "@/lib/qr";
import { attachApi, type AttachTokenResponse } from "@/lib/attach-api";

interface Props {
	sessionId: string;
	open: boolean;
	onClose: () => void;
}

export function SessionAttachQR({ sessionId, open, onClose }: Props) {
	const [data, setData] = useState<AttachTokenResponse | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);

	async function fetchToken(): Promise<void> {
		if (!sessionId) return;
		setLoading(true);
		setError(null);
		try {
			const res = await attachApi.createAttachToken(sessionId);
			setData(res);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		if (open) {
			setData(null);
			setCopied(false);
			void fetchToken();
		}
	}, [open, sessionId]);

	async function copyLink(): Promise<void> {
		if (!data?.url) return;
		try {
			await navigator.clipboard.writeText(data.url);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch {
			setError("Failed to copy URL to clipboard");
		}
	}

	return (
		<Modal open={open} onClose={onClose} widthClass="max-w-md">
			<div className="flex h-11 items-center justify-between border-b border-line px-4">
				<h2 className="font-semibold text-ink text-sm">Continue on Phone</h2>
				<Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
					<X className="h-4 w-4" />
				</Button>
			</div>

			<div className="flex flex-col items-center space-y-4 p-5 text-center">
				{loading ? (
					<div className="flex h-48 w-48 items-center justify-center rounded-md border border-line bg-paper-2 text-ink-3 text-xs">
						<RefreshCw className="mr-2 h-4 w-4 animate-spin" />
						Generating QR link...
					</div>
				) : error ? (
					<div className="w-full rounded-md border border-danger/30 bg-danger/10 p-3 text-danger text-xs">
						{error}
						<div className="mt-2 flex justify-center">
							<Button variant="outline" size="sm" onClick={() => void fetchToken()}>
								Retry
							</Button>
						</div>
					</div>
				) : data ? (
					<>
						<div
							className="rounded-lg border border-line bg-white p-3 shadow-sm"
							dangerouslySetInnerHTML={{ __html: generateQrSvg(data.url, 200) }}
						/>

						<div className="w-full space-y-1.5 text-left">
							<label className="block text-ink-3 text-xs">Attach Link</label>
							<div className="flex gap-2">
								<input
									type="text"
									readOnly
									value={data.url}
									className="flex-1 rounded-md border border-line bg-paper-2 px-3 py-1.5 font-mono text-ink text-xs focus:outline-none"
								/>
								<Button variant="outline" size="sm" onClick={() => void copyLink()}>
									{copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
									{copied ? "Copied" : "Copy Link"}
								</Button>
							</div>
						</div>

						<p className="text-ink-3 text-xs">Token valid for 10 minutes</p>
					</>
				) : null}
			</div>
		</Modal>
	);
}
