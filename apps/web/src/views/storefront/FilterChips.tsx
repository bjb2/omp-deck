import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

const SECTIONS: ReadonlyArray<{ value: "all" | "plugins" | "mcps" | "skills" | "prompts"; label: string }> = [
	{ value: "all", label: "All" },
	{ value: "plugins", label: "Plugins" },
	{ value: "mcps", label: "MCPs" },
	{ value: "skills", label: "Skills" },
	{ value: "prompts", label: "Prompts" },
];

export function FilterChips({ active }: { active: "all" | "plugins" | "mcps" | "skills" | "prompts" }) {
	return (
		<div className="flex flex-wrap gap-2">
			{SECTIONS.map((s) => {
				const isActive = active === s.value;
				const to = s.value === "all" ? "/storefront" : `/storefront/${s.value}`;
				return (
					<Link
						key={s.value}
						to={to}
						className={cn(
							"rounded-full border px-3 py-1 font-mono text-2xs uppercase tracking-meta transition-colors",
							isActive
								? "border-accent bg-accent/10 text-accent"
								: "border-line bg-paper text-ink-3 hover:border-ink/30 hover:text-ink",
						)}
					>
						{s.label}
					</Link>
				);
			})}
		</div>
	);
}
