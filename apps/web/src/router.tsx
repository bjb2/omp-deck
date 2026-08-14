import { Suspense, lazy, useEffect, useRef } from "react";
import { createBrowserRouter, Outlet, RouterProvider, useLocation, useNavigate } from "react-router-dom";
import { ChatView } from "./views/ChatView";
import { TasksView } from "./views/TasksView";
import { RoutinesView } from "./views/RoutinesView";
import { RunDetailView } from "./views/RunDetailView";
import { InboxView } from "./views/InboxView";
import { MarketplaceView } from "./views/MarketplaceView";
import { KbView } from "./views/KbView";
import { SkillsView } from "./views/SkillsView";
import { SettingsView } from "./views/SettingsView";
import { IntegrationsView } from "./views/IntegrationsView";
import { OnboardingView } from "./views/OnboardingView";
import { WorkflowsView } from "./views/WorkflowsView";
import { GholamView } from "./views/GholamView";
import { GholamChats } from "./views/GholamChats";
import { GholamChatView } from "./views/GholamChat";
import { GholamChatNew } from "./views/GholamChatNew";
import { PromptsLibrary } from "./views/PromptsLibrary";
import { PromptsDiscover } from "./views/PromptsDiscover";
import { PromptsShare } from "./views/PromptsShare";
import { PreviewView } from "./views/PreviewView";
import { StudioView } from "./views/StudioView";
import { StorefrontHome } from "./views/storefront/StorefrontHome";
import { StorefrontSection } from "./views/storefront/StorefrontSection";
import { StorefrontDetail } from "./views/storefront/StorefrontDetail";
import { StorefrontSearch } from "./views/storefront/StorefrontSearch";
import { onboardingApi } from "./lib/onboarding-api";

/**
 * Explorer and Agent Config pull in CodeMirror (~600KB minified) for the code
 * editor and diff viewer. Neither is needed to open the app and chat — the
 * common case, especially on the mobile PWA where every extra kilobyte of
 * initial JS is a slower first paint on a cellular connection — so both are
 * code-split behind React.lazy rather than bundled into the main chunk.
 */
const ExplorerView = lazy(() => import("./views/ExplorerView").then((m) => ({ default: m.ExplorerView })));
const AgentConfigView = lazy(() => import("./views/AgentConfigView").then((m) => ({ default: m.AgentConfigView })));

function LazyViewFallback() {
	return (
		<div className="flex h-full w-full items-center justify-center bg-paper">
			<div className="font-mono text-2xs text-ink-3">Loading…</div>
		</div>
	);
}

/**
 * First-paint redirect: if the server reports `needsOnboarding`, route
 * brand-new users to the wizard instead of an empty chat. Only triggers
 * once per page load and only when the user lands on `/` — typing any
 * other URL bypasses the gate (the wizard is escapable, and we don't
 * want to re-trap users who already saw it).
 */
function OnboardingGate() {
	const navigate = useNavigate();
	const location = useLocation();
	const checked = useRef(false);
	useEffect(() => {
		if (checked.current) return;
		checked.current = true;
		if (location.pathname !== "/") return; // user explicitly navigated; respect that
		void onboardingApi
			.state()
			.then((state) => {
				if (state.needsOnboarding) navigate("/onboarding", { replace: true });
			})
			.catch(() => {
				// State endpoint failed — don't block the app. Onboarding can be
				// re-run from Settings if the gate misfires.
			});
	}, [location.pathname, navigate]);
	return <Outlet />;
}

const router = createBrowserRouter([
	{
		element: <OnboardingGate />,
		children: [
			{ path: "/", element: <ChatView /> },
			{
				path: "/explorer",
				element: (
					<Suspense fallback={<LazyViewFallback />}>
						<ExplorerView />
					</Suspense>
				),
			},
			{
				path: "/agent-config",
				element: (
					<Suspense fallback={<LazyViewFallback />}>
						<AgentConfigView />
					</Suspense>
				),
			},
			{ path: "/tasks", element: <TasksView /> },
			{ path: "/routines", element: <RoutinesView /> },
			{ path: "/workflows", element: <WorkflowsView /> },
			{ path: "/gholam", element: <GholamView /> },
			{ path: "/gholam/chats", element: <GholamChats /> },
			{ path: "/gholam/chat/new", element: <GholamChatNew /> },
			{ path: "/gholam/chat/:chatId", element: <GholamChatView /> },
			{ path: "/routines/:id/runs/:runId", element: <RunDetailView /> },
			{ path: "/inbox", element: <InboxView /> },
			{ path: "/marketplace", element: <MarketplaceView /> },
			{ path: "/skills", element: <SkillsView /> },
			{ path: "/prompts/library", element: <PromptsLibrary /> },
			{ path: "/prompts/discover", element: <PromptsDiscover /> },
			{ path: "/prompts/share/:slug", element: <PromptsShare /> },
			{ path: "/kb", element: <KbView /> },
			{ path: "/integrations", element: <IntegrationsView /> },
			{ path: "/settings", element: <SettingsView /> },
			{ path: "/onboarding", element: <OnboardingView /> },
			// §3 + §4 of docs/GENERATIVE.md — pre-update preview + studio shell.
			// /studio (no pane) is the 3-col grid; /studio/:pane focuses on a single pane.
			// Worker J (Studio) owns these routes; do not move.
			{ path: "/studio", element: <StudioView /> },
			{ path: "/preview/:route", element: <PreviewView /> },
			{ path: "/studio/:pane", element: <StudioView /> },
			// Storefront (§1 of docs/STOREFRONT.md) — discovery, sections, detail.
			{ path: "/storefront", element: <StorefrontHome /> },
			{ path: "/storefront/search", element: <StorefrontSearch /> },
			{ path: "/storefront/:section", element: <StorefrontSection /> },
			{ path: "/storefront/:section/:id", element: <StorefrontDetail /> },
		],
	},
]);

export function AppRouter() {
	return <RouterProvider router={router} />;
}
