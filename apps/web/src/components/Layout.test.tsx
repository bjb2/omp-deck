/**
 * Layout a11y contract: collapsed panels must inert themselves (not just
 * `aria-hidden`, which doesn't move keyboard focus), and Escape must close
 * the open inspector at lg+ breakpoints. Navigation / overlay components
 * aren't relevant to either assertion so we stub them out.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { useStore } from "@/lib/store";
import { Layout } from "./Layout";

// Children of Layout that aren't on the contract surface for these tests:
// we just want the `<aside>` roots the inert effect targets, and the
// keyboard listener on `window`.
vi.mock("./NavRail", () => ({ NavRail: () => null }));
vi.mock("./ConnectionIndicator", () => ({ ConnectionIndicator: () => null }));
vi.mock("./GholamOverlay", () => ({ GholamOverlay: () => null }));
vi.mock("@/lib/studio/Tooltip", () => ({ TooltipSurface: () => null }));
vi.mock("@/lib/studio/ContextMenu", () => ({ ContextMenuSurface: () => null }));

afterEach(() => {
	cleanup();
	// Reset any panel state changes between tests so each starts collapsed.
	useStore.setState({ sidebarOpen: false, inspectorOpen: false });
});

function renderLayout() {
	return render(
		<Layout
			sidebar={<div data-testid="sidebar-body" />}
			main={<div data-testid="main-body" />}
			inspector={<div data-testid="inspector-body" />}
		/>,
	);
}

function inertOf(el: HTMLElement): boolean {
	return (el as unknown as { inert: boolean }).inert;
}

describe("Layout a11y", () => {
	test("collapsed panels inert their root, removing them from tab order", () => {
		// Default state: sidebar open, inspector closed at lg+. Override
		// both closed first so we assert the inert=true baseline, then
		// open the inspector and re-query (the React render can detach
		// the prior node — never reuse a captured <aside> ref across
		// a state flip).
		useStore.setState({ sidebarOpen: false, inspectorOpen: false });
		const { getByLabelText } = renderLayout();

		expect(inertOf(getByLabelText("Sessions"))).toBe(true);
		expect(inertOf(getByLabelText("Inspector"))).toBe(true);

		act(() => {
			useStore.getState().setInspectorOpen(true);
		});
		// The DOM-property `inert` is set in a useEffect — wrapping the state
		// flip in act() lets React commit and run the effect before the
		// assertion reads the DOM node.
		expect(inertOf(getByLabelText("Inspector"))).toBe(false);
		expect(inertOf(getByLabelText("Sessions"))).toBe(true);
	});

	test("Escape key while the inspector is open closes it", () => {
		useStore.setState({ sidebarOpen: false, inspectorOpen: true });
		const { getByLabelText } = renderLayout();
		expect(inertOf(getByLabelText("Inspector"))).toBe(false);

		act(() => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		});

		expect(useStore.getState().inspectorOpen).toBe(false);
		expect(inertOf(getByLabelText("Inspector"))).toBe(true);
	});
});
