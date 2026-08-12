import type { Config } from "tailwindcss";

/**
 * Every color and font here resolves through a CSS custom property so the
 * active theme (driven by `<html data-theme="...">`) can swap the palette at
 * runtime with no rebuild. Channel values live as space-separated `R G B`
 * triplets in `styles.css` so the `<alpha-value>` substitution that Tailwind
 * does for `bg-paper/40`, `text-ink-3/60`, etc. still works.
 */
const channel = (token: string): string => `rgb(var(--${token}) / <alpha-value>)`;

const config: Config = {
	content: ["./index.html", "./src/**/*.{ts,tsx}"],
	theme: {
		extend: {
			colors: {
				paper: {
					DEFAULT: channel("paper"),
					2: channel("paper-2"),
					3: channel("paper-3"),
					code: channel("paper-code"),
				},
				ink: {
					DEFAULT: channel("ink"),
					2: channel("ink-2"),
					3: channel("ink-3"),
					4: channel("ink-4"),
				},
				line: {
					DEFAULT: channel("line"),
					strong: channel("line-strong"),
				},
				accent: {
					DEFAULT: channel("accent"),
					soft: channel("accent-soft"),
					2: channel("accent-2"),
				},
				success: channel("success"),
				warn: channel("warn"),
				danger: channel("danger"),
				thinking: channel("thinking"),
			},
			fontFamily: {
				sans: ["var(--font-sans)"],
				mono: ["var(--font-mono)"],
			},
			fontSize: {
				"2xs": ["0.6875rem", { lineHeight: "1rem" }],
			},
			letterSpacing: {
				meta: "0.06em",
			},
			boxShadow: {
				composer: "0 -1px 0 0 rgb(var(--line) / 1)",
			},
			borderColor: {
				DEFAULT: channel("line"),
			},
			divideColor: {
				DEFAULT: channel("line"),
			},
			ringColor: {
				DEFAULT: channel("ink"),
			},
		},
	},
	plugins: [],
};

export default config;
