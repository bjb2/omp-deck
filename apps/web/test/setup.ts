import "@testing-library/jest-dom/vitest";

// jsdom doesn't polyfill these Layout's `useEffect` Esc-closer relies on.
if (typeof globalThis.matchMedia !== "function") {
	globalThis.matchMedia = (query: string) =>
		({
			matches: false,
			media: query,
			onchange: null,
			addListener: () => {},
			removeListener: () => {},
			addEventListener: () => {},
			removeEventListener: () => {},
			dispatchEvent: () => false,
		}) as unknown as MediaQueryList;
}
