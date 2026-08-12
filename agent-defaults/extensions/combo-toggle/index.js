// /combo session toggle — set all three (caveman, rtk, ponytail) at once.
// Modes: off | medium | max

const LEVELS = {
  off: {
    caveman: "off",
    rtk: "off",
    ponytail: "off",
  },
  medium: {
    caveman: "lite",
    rtk: "on",
    ponytail: "lite",
  },
  max: {
    caveman: "ultra",
    rtk: "on",
    ponytail: "ultra",
  },
};

const DEFAULT_LEVEL = "off";

function normalizeLevel(value) {
  const v = String(value || "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVELS, v) ? v : null;
}

function levelSummary(level) {
  const v = LEVELS[level];
  return `caveman=${v.caveman} rtk=${v.rtk} ponytail=${v.ponytail}`;
}

function resolveComboLevel(entries, fallback = DEFAULT_LEVEL) {
  if (!Array.isArray(entries)) return fallback;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "custom" || entry?.customType !== "combo-level") continue;
    const level = normalizeLevel(entry?.data?.level);
    if (level) return level;
  }
  return fallback;
}

export default function comboToggleExtension(pi) {
  pi.setLabel?.("Combo session toggle (all 3 add-ons)");

  let currentLevel = DEFAULT_LEVEL;
  let lastCtx = null;

  function syncStatus(ctx) {
    if (ctx) lastCtx = ctx;
    const c = ctx || lastCtx;
    if (!c?.ui?.setStatus) return;

    if (currentLevel === "off") {
      c.ui.setStatus("combo", "");
      return;
    }

    const levels = LEVELS[currentLevel];
    const theme = c.ui.theme;
    const indicator = theme?.fg ? theme.fg("accent", "🧩") : "🧩";
    const label = `combo: ${currentLevel.toUpperCase()} · caveman=${levels.caveman.toUpperCase()} · rtk=${levels.rtk.toUpperCase()} · ponytail=${levels.ponytail.toUpperCase()}`;
    c.ui.setStatus("combo", theme?.fg ? `${indicator} ${theme.fg("muted", label)}` : `${indicator} ${label}`);
  }

  pi.registerCommand("combo", {
    description: "Toggle all 3 OMP add-ons at once. Usage: /combo <off|medium|max|status>",
    handler: async (args, ctx) => {
      const arg = String(args || "").trim().toLowerCase();

      if (!arg || arg === "status") {
        const levels = LEVELS[currentLevel];
        ctx?.ui?.notify?.(
          `Combo: ${currentLevel.toUpperCase()} (${levelSummary(currentLevel)})`,
          "info"
        );
        return;
      }

      if (arg === "help") {
        ctx?.ui?.notify?.(
          "/combo off    — disables all 3 (caveman, rtk, ponytail)\n" +
          "/combo medium — light: caveman=lite, rtk=on, ponytail=lite\n" +
          "/combo max    — aggressive: caveman=ultra, rtk=on, ponytail=ultra",
          "info"
        );
        return;
      }

      const level = normalizeLevel(arg);
      if (!level) {
        ctx?.ui?.notify?.(
          `Unknown combo level: ${arg}. Use: off | medium | max`,
          "warning"
        );
        return;
      }

      const levels = LEVELS[level];

      // Persist per-extension state so they restore on session_start
      pi.appendEntry("caveman-mode", { mode: levels.caveman });
      pi.appendEntry("rtk-mode", { enabled: levels.rtk === "on" });
      pi.appendEntry("ponytail-mode", { mode: levels.ponytail });
      pi.appendEntry("combo-level", { level });

      currentLevel = level;
      syncStatus(ctx);

      ctx?.ui?.notify?.(
        `Combo ${level} applied: ${levelSummary(level)}`,
        "info"
      );

      if (ctx?.reload) {
        await ctx.reload();
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const entries = ctx?.sessionManager?.getBranch?.() || ctx?.sessionManager?.getEntries?.() || [];
    currentLevel = resolveComboLevel(entries);
    syncStatus(ctx);
  });

  // Remove natural-language handler (pi.on("input", ...)) to avoid accidental triggers
  // and because it lacks ctx for reload. Use slash commands only.
}