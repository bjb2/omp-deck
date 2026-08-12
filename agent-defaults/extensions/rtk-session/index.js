import os from "node:os";
import path from "node:path";

const DEFAULT_ENABLED = false;

function asBoolean(value, fallback = DEFAULT_ENABLED) {
  if (typeof value === "boolean") return value;
  if (value === "on" || value === "true") return true;
  if (value === "off" || value === "false") return false;
  return fallback;
}

function resolveEnabled(entries, fallback = DEFAULT_ENABLED) {
  if (!Array.isArray(entries)) return fallback;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "custom" || entry?.customType !== "rtk-mode") continue;
    return asBoolean(entry?.data?.enabled, fallback);
  }
  return fallback;
}

const IS_WINDOWS = process.platform === "win32";
const HOME = os.homedir();
const RTK_BINARY = path.join(HOME, ".bun", "bin", IS_WINDOWS ? "rtk.exe" : "rtk");

const RTK_PROMPT = `RTK mode active for this session.
Use Rust Token Killer for shell output that would otherwise be noisy. Prefer explicit RTK commands in bash: \`rtk git status\`, \`rtk git diff\`, \`rtk read <file>\`, \`rtk grep <pattern> <path>\`, \`rtk find <glob> <path>\`, \`rtk test <cmd...>\`, \`rtk tsc\`, \`rtk lint\`, or \`rtk <tool> ...\` for supported dev commands.
Do not use RTK when exact raw output is required, when a specialized OMP tool is required by system policy, or when the command changes state and RTK would hide important confirmation text. Specialized OMP tools still win: read/glob/grep/edit/lsp stay preferred over shell equivalents.`;

export default function rtkSessionExtension(pi) {
  const { z } = pi.zod;
  let enabled = DEFAULT_ENABLED;
  let isActive = false;
  let lastCtx = null;

  function syncStatus(ctx) {
    if (ctx) lastCtx = ctx;
    const c = ctx || lastCtx;
    if (!c?.ui?.setStatus) return;
    if (!enabled) {
      c.ui.setStatus("rtk", "");
      return;
    }
    const theme = c.ui.theme;
    const indicator = isActive && theme?.fg ? theme.fg("accent", "●") : "●";
    const label = "rtk: ON";
    c.ui.setStatus("rtk", theme?.fg ? `${indicator} ${theme.fg("muted", label)}` : `${indicator} ${label}`);
  }

  function setEnabled(next, ctx) {
    enabled = Boolean(next);
    pi.appendEntry("rtk-mode", { enabled });
    syncStatus(ctx);
    ctx?.ui?.notify?.(`RTK mode ${enabled ? "on" : "off"}.`, "info");
  }

  pi.setLabel?.("RTK session toggle");

  pi.registerCommand("rtk", {
    description: "Toggle RTK compact shell-output guidance for this session",
    handler: async (args, ctx) => {
      const arg = String(args || "").trim().toLowerCase();
      if (!arg || arg === "status") {
        ctx?.ui?.notify?.(`RTK: ${enabled ? "on" : "off"}`, "info");
        return;
      }
      if (["on", "enable", "enabled", "true"].includes(arg)) {
        setEnabled(true, ctx);
        return;
      }
      if (["off", "disable", "disabled", "false"].includes(arg)) {
        setEnabled(false, ctx);
        return;
      }
      ctx?.ui?.notify?.("Usage: /rtk [on|off|status]", "warning");
    },
  });

  pi.registerTool({
    name: "rtk_run",
    label: "RTK Run",
    description: "Run the installed `rtk` binary for compact command output when RTK mode is enabled.",
    parameters: z.object({
      args: z.array(z.string()).min(1).describe("Arguments passed to rtk, e.g. ['git','status'] or ['read','src/index.ts']"),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!enabled) {
        return {
          isError: true,
          content: [{ type: "text", text: "RTK mode is off. Run /rtk on for this session, or use bash explicitly." }],
          details: { enabled },
        };
      }
      onUpdate?.({ content: [{ type: "text", text: `rtk ${params.args.join(" ")}` }], details: { phase: "start" } });
      const result = await pi.exec(RTK_BINARY, params.args, { signal, cwd: ctx?.cwd || pi.cwd });
      const text = [result.stdout, result.stderr].filter(Boolean).join(result.stdout && result.stderr ? "\n" : "");
      return {
        isError: result.code !== 0,
        content: [{ type: "text", text: text || `rtk exited ${result.code}` }],
        details: { code: result.code, killed: result.killed, enabled },
      };
    },
  });

  pi.on("input", async (event) => {
    if (event?.source === "extension") return;
    const t = String(event?.text || "").trim().toLowerCase().replace(/[.!?\s]+$/, "");
    if (t === "rtk on" || t === "use rtk") setEnabled(true);
    if (t === "rtk off" || t === "stop rtk") setEnabled(false);
  });

  pi.on("session_start", async (_event, ctx) => {
    const entries = ctx?.sessionManager?.getBranch?.() || ctx?.sessionManager?.getEntries?.() || [];
    enabled = resolveEnabled(entries);
    syncStatus(ctx);
    ctx?.ui?.notify?.(`RTK loaded: ${enabled ? "on" : "off"}`, "info");
  });

  pi.on("agent_start", async (_event, ctx) => {
    isActive = true;
    syncStatus(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    isActive = false;
    syncStatus(ctx);
  });

  pi.on("before_agent_start", async (event) => {
    if (!enabled) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${RTK_PROMPT}` };
  });
}
