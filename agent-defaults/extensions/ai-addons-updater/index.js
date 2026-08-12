// OMP extension: /ai-addons manual updater for Ponytail, RTK, Caveman.
// Built-in Node modules only. Default off; registers a single slash command.
// ponytail: `skipped: none` — semantics match one-liner: fetch + compare + run install.
// rtk: `skipped: signature verification` — checksums.txt ships only SHA256 of release assets; add sigchain when upstream publishes a signing key.
// caveman: `skipped: none` — exactly the ask: write rule.md, report old/new hash.

import https from "node:https";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const IS_WINDOWS = process.platform === "win32";
const HOME = os.homedir();

const PONYTAIL_REMOTE = "https://raw.githubusercontent.com/DietrichGebert/ponytail/main/package.json";
const PONYTAIL_LOCAL = path.join(HOME, ".omp", "plugins", "node_modules", "@dietrichgebert", "ponytail", "package.json");
const RTK_RELEASE_API = "https://api.github.com/repos/rtk-ai/rtk/releases/latest";
const RTK_BINARY = path.join(HOME, ".bun", "bin", IS_WINDOWS ? "rtk.exe" : "rtk");
const CAVEMAN_REMOTE = "https://raw.githubusercontent.com/JuliusBrussee/caveman/main/src/rules/caveman-activate.md";
const CAVEMAN_LOCAL = path.join(HOME, ".omp", "agent", "extensions", "caveman-session", "rule.md");

const RELOAD_MSG = "Reminder: restart OMP (or reload extensions) for updates to take effect.";

function httpsGet(url, { maxRedirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "omp-ai-addons-updater", Accept: "application/json,*/*" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (maxRedirects <= 0) { res.resume(); return reject(new Error("Too many redirects")); }
        res.resume();
        const next = new URL(res.headers.location, url).href;
        return resolve(httpsGet(next, { maxRedirects: maxRedirects - 1 }));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      let body = "";
      // ponytail: streamed accumulation — fine for tens of KB; stream-pipe if assets ever exceed a few MB.
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.setTimeout(30000, () => req.destroy(new Error(`Timeout fetching ${url}`)));
  });
}

function httpsDownload(url, dest, { maxRedirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "omp-ai-addons-updater", Accept: "*/*" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (maxRedirects <= 0) { res.resume(); return reject(new Error("Too many redirects")); }
        res.resume();
        const next = new URL(res.headers.location, url).href;
        return resolve(httpsDownload(next, dest, { maxRedirects: maxRedirects - 1 }));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      const file = createWriteStream(dest);
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
      file.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(120000, () => req.destroy(new Error(`Timeout downloading ${url}`)));
  });
}

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function normalizeRtkVersion(value) {
  return String(value || "").replace(/^rtk\s+/i, "").replace(/^v/i, "").trim();
}

async function readTextIfExists(p) {
  try { return await fs.readFile(p, "utf8"); } catch { return null; }
}

function notify(ctx, msg, level) {
  ctx?.ui?.notify?.(String(msg), level || "info");
}

// Check: no mutation.
async function checkAddons(ctx) {
  const lines = [];

  // Ponytail
  try {
    const remoteRaw = await httpsGet(PONYTAIL_REMOTE);
    const remoteJson = JSON.parse(remoteRaw);
    const localRaw = await readTextIfExists(PONYTAIL_LOCAL);
    const localVer = localRaw ? JSON.parse(localRaw).version : null;
    const remoteVer = remoteJson.version;
    const status = !localVer ? "not installed"
      : localVer === remoteVer ? "up to date"
      : "update available";
    const m = `Ponytail ${status}: local=${localVer || "—"} latest=${remoteVer}`;
    lines.push(m); notify(ctx, m, "info");
  } catch (e) {
    const m = `Ponytail check failed: ${e.message}`;
    lines.push(m); notify(ctx, m, "warning");
  }

  // RTK
  try {
    const releaseRaw = await httpsGet(RTK_RELEASE_API);
    const release = JSON.parse(releaseRaw);
    const latestTag = release.tag_name || null;
    let localVer = null;
    try {
      const out = execFileSync(RTK_BINARY, ["--version"], { encoding: "utf8", windowsHide: true, shell: false, timeout: 10000 }) || "";
      if (out) localVer = out.trim().split(/\r?\n/)[0];
    } catch { localVer = null; }
    const status = localVer == null ? "not installed"
      : normalizeRtkVersion(localVer) === normalizeRtkVersion(latestTag) ? "up to date"
      : "update available";
    const m = `RTK ${status}: local=${localVer || "—"} latest=${latestTag || "—"}`;
    lines.push(m); notify(ctx, m, "info");
  } catch (e) {
    const m = `RTK check failed: ${e.message}`;
    lines.push(m); notify(ctx, m, "warning");
  }

  // Caveman (rule.md)
  try {
    const remote = await httpsGet(CAVEMAN_REMOTE);
    const remoteHash = sha256Hex(remote).slice(0, 16);
    const local = await readTextIfExists(CAVEMAN_LOCAL);
    const localHash = local ? sha256Hex(local).slice(0, 16) : null;
    const status = !local ? "rule.md missing"
      : localHash === remoteHash ? "rule.md up to date"
      : "rule.md update available";
    const m = `Caveman ${status}: local=${localHash || "—"} remote=${remoteHash}`;
    lines.push(m); notify(ctx, m, "info");
  } catch (e) {
    const m = `Caveman check failed: ${e.message}`;
    lines.push(m); notify(ctx, m, "warning");
  }

  return lines.join("\n");
}

async function updatePonytail(pi, ctx, dryRun = false) {
  if (dryRun) {
    const m = "Ponytail dry-run: would run `omp plugin install github:DietrichGebert/ponytail`.";
    notify(ctx, m, "info");
    return m;
  }
  notify(ctx, "Ponytail: running omp plugin install…", "info");
  let out = "";
  try {
    const r = await pi.exec("omp", ["plugin", "install", "github:DietrichGebert/ponytail"], { cwd: ctx?.cwd || pi.cwd });
    out = [r.stdout, r.stderr].filter(Boolean).join("\n").trim();
    if (r.code !== 0) throw new Error(r.stderr || `omp exited ${r.code}`);
  } catch (e) {
    const m = `Ponytail update failed: ${e.message}`;
    notify(ctx, m, "warning");
    return m;
  }
  const m = `Ponytail update finished.${out ? `\n${out}` : ""}\n${RELOAD_MSG}`;
  notify(ctx, "Ponytail update finished. " + RELOAD_MSG, "info");
  return m;
}
async function updateRtk(ctx, dryRun = false) {
  let release;
  try {
    const raw = await httpsGet(RTK_RELEASE_API);
    release = JSON.parse(raw);
  } catch (e) {
    const m = `RTK: cannot fetch release info: ${e.message}`;
    notify(ctx, m, "warning"); return m;
  }
  const tag = release.tag_name || "unknown";
  const assets = Array.isArray(release.assets) ? release.assets : [];

  // Cross-platform asset selection (mirrors installer stepRtk)
  const PLATFORM = process.platform;
  const ARCH = process.arch;
  let assetTriple;
  let assetExt;
  let binaryName;
  if (PLATFORM === "win32" && ARCH === "x64") {
    assetTriple = "x86_64-pc-windows-msvc";
    assetExt = ".zip";
    binaryName = "rtk.exe";
  } else if (PLATFORM === "linux" && ARCH === "x64") {
    assetTriple = "x86_64-unknown-linux-musl";
    assetExt = ".tar.gz";
    binaryName = "rtk";
  } else if (PLATFORM === "linux" && ARCH === "arm64") {
    assetTriple = "aarch64-unknown-linux-gnu";
    assetExt = ".tar.gz";
    binaryName = "rtk";
  } else if (PLATFORM === "darwin" && ARCH === "x64") {
    assetTriple = "x86_64-apple-darwin";
    assetExt = ".tar.gz";
    binaryName = "rtk";
  } else if (PLATFORM === "darwin" && ARCH === "arm64") {
    assetTriple = "aarch64-apple-darwin";
    assetExt = ".tar.gz";
    binaryName = "rtk";
  } else {
    const m = `RTK: unsupported platform ${PLATFORM}/${ARCH}`;
    notify(ctx, m, "warning"); return m;
  }

  const asset = assets.find((a) => a.name === `rtk-${assetTriple}${assetExt}`);
  const checksAsset = assets.find((a) => a.name === "checksums.txt");
  if (!asset || !checksAsset) {
    const m = `RTK: required assets not found in release ${tag} (need rtk-${assetTriple}${assetExt} and checksums.txt)`;
    notify(ctx, m, "warning"); return m;
  }

  if (dryRun) {
    const m = `RTK dry-run: would download ${asset.name} (${tag}), verify checksums.txt, and replace ${RTK_BINARY}.`;
    notify(ctx, m, "info");
    return m;
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rtk-update-"));
  const archivePath = path.join(tmp, asset.name);
  const checksPath = path.join(tmp, "checksums.txt");

  try {
    notify(ctx, `RTK: downloading ${asset.name} (${tag})…`, "info");
    await httpsDownload(asset.browser_download_url, archivePath);
    notify(ctx, "RTK: downloading checksums.txt…", "info");
    await httpsDownload(checksAsset.browser_download_url, checksPath);

    // Verify SHA256 against checksums.txt
    const checks = await fs.readFile(checksPath, "utf8");
    const expected = (() => {
      let hit = null;
      for (const line of checks.split(/\r?\n/)) {
        const m = line.match(/^[0-9a-fA-F]{64}\s+\*?(.+)$/);
        if (m && path.basename(m[2]) === asset.name) { hit = m[1].toLowerCase(); break; }
      }
      return hit;
    })();
    if (!expected) {
      const m = `RTK: checksums.txt has no entry for ${asset.name}`;
      notify(ctx, m, "warning"); return m;
    }
    const archiveBuf = await fs.readFile(archivePath);
    const actual = createHash("sha256").update(archiveBuf).digest("hex").toLowerCase();
    if (actual !== expected) {
      const m = `RTK: checksum mismatch! expected=${expected.slice(0,12)}… actual=${actual.slice(0,12)}…`;
      notify(ctx, m, "warning"); return m;
    }
    notify(ctx, "RTK: checksum verified.", "info");

    // Extract by archive format
    const extractDir = path.join(tmp, "extracted");
    await fs.mkdir(extractDir, { recursive: true });

    if (asset.name.endsWith(".zip")) {
      if (IS_WINDOWS) {
        execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
          `Expand-Archive -LiteralPath "${archivePath}" -DestinationPath "${extractDir}" -Force`],
          { encoding: "utf8", windowsHide: true, shell: false });
      } else {
        execFileSync("unzip", [archivePath, "-d", extractDir], { encoding: "utf8", shell: false });
      }
    } else if (asset.name.endsWith(".tar.gz") || asset.name.endsWith(".tgz")) {
      try {
        execFileSync("tar", ["xzf", archivePath, "-C", extractDir], { encoding: "utf8", shell: false });
      } catch (e) {
        execFileSync("sh", ["-c", `gunzip < "${archivePath}" | tar xf - -C "${extractDir}"`], { encoding: "utf8", shell: false });
      }
    } else {
      throw new Error(`Unknown archive format: ${asset.name}`);
    }

    const rtkExtracted = await findFile(extractDir, binaryName);
    if (!rtkExtracted) {
      const m = `RTK: ${binaryName} not found in extracted archive`;
      notify(ctx, m, "warning"); return m;
    }
    const backupPath = `${RTK_BINARY}.bak`;
    let backedUp = false;
    try {
      await fs.copyFile(RTK_BINARY, backupPath);
      backedUp = true;
    } catch {
      backedUp = false;
    }

    await fs.copyFile(rtkExtracted, RTK_BINARY);

    // Set executable bit on Unix
    if (!IS_WINDOWS) {
      await fs.chmod(RTK_BINARY, 0o755);
    }

    let versionOut = "";
    try {
      versionOut = execFileSync(RTK_BINARY, ["--version"], { encoding: "utf8", windowsHide: true, shell: false, timeout: 10000 }).trim();
    } catch (e) {
      if (backedUp) await fs.copyFile(backupPath, RTK_BINARY);
      throw new Error(`new ${binaryName} failed --version${backedUp ? "; restored backup" : ""}: ${e.message}`);
    }
    if (normalizeRtkVersion(versionOut) !== normalizeRtkVersion(tag)) {
      if (backedUp) await fs.copyFile(backupPath, RTK_BINARY);
      throw new Error(`new ${binaryName} reports ${versionOut}, expected ${tag}${backedUp ? "; restored backup" : ""}`);
    }
    const m = `RTK updated to ${tag} → ${RTK_BINARY}\nbackup=${backedUp ? backupPath : "—"}\n${RELOAD_MSG}`;
    notify(ctx, "RTK update finished. " + RELOAD_MSG, "info");
    return m;
  } catch (e) {
    const m = `RTK update failed: ${e.message}`;
    notify(ctx, m, "warning"); return m;
  } finally {
    fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function findFile(dir, name) {
  try {
    const ents = await fs.readdir(dir, { withFileTypes: true });
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        const r = await findFile(full, name);
        if (r) return r;
      } else if (e.isFile()) {
        if (e.name === name) return full;
        // Match rtk-* asset names (e.g. rtk-x86_64-unknown-linux-musl)
        if (name === "rtk" || name === "rtk.exe") {
          const base = e.name.toLowerCase();
          if (!/\.(txt|md|json|sha256|sig|asc|pem|crt|license)$/i.test(base)) {
            if (base === "rtk" || base === "rtk.exe" || /^rtk[-_.]/.test(base)) return full;
          }
        }
      }
    }
  } catch { /* ignore */ }
  return null;
}

async function updateCaveman(ctx, dryRun = false) {
  let remote;
  try { remote = await httpsGet(CAVEMAN_REMOTE); }
  catch (e) { const m = `Caveman update failed: ${e.message}`; notify(ctx, m, "warning"); return m; }

  const remoteHash = sha256Hex(remote).slice(0, 16);
  const oldLocal = await readTextIfExists(CAVEMAN_LOCAL);
  const oldHash = oldLocal ? sha256Hex(oldLocal).slice(0, 16) : null;

  if (dryRun) {
    const m = `Caveman dry-run: would write ${CAVEMAN_LOCAL}\nold=${oldHash || "—"} new=${remoteHash}.`;
    notify(ctx, m, "info");
    return m;
  }

  try {
    await fs.mkdir(path.dirname(CAVEMAN_LOCAL), { recursive: true });
    const backupPath = `${CAVEMAN_LOCAL}.bak`;
    if (oldLocal !== null) await fs.writeFile(backupPath, oldLocal, "utf8");
    await fs.writeFile(CAVEMAN_LOCAL, remote, "utf8");
    const written = await fs.readFile(CAVEMAN_LOCAL, "utf8");
    const writtenHash = sha256Hex(written).slice(0, 16);
    if (writtenHash !== remoteHash) {
      if (oldLocal !== null) await fs.writeFile(CAVEMAN_LOCAL, oldLocal, "utf8");
      throw new Error(`written hash ${writtenHash} did not match remote ${remoteHash}${oldLocal !== null ? "; restored backup" : ""}`);
    }
    const m = `Caveman rule.md updated → ${CAVEMAN_LOCAL}\nold=${oldHash || "—"} new=${remoteHash}\nbackup=${oldLocal !== null ? backupPath : "—"}\n${RELOAD_MSG}`;
    notify(ctx, "Caveman rule.md updated. " + RELOAD_MSG, "info");
    return m;
  } catch (e) {
    const m = `Caveman update failed: ${e.message}`;
    notify(ctx, m, "warning");
    return m;
  }
}

export default function aiAddonsUpdaterExtension(pi) {
  pi.setLabel?.("AI add-ons updater");

  pi.registerCommand("ai-addons", {
    description: "Check or update AI add-ons (ponytail/rtk/caveman/all). Usage: /ai-addons <check|status|update ponytail|rtk|caveman|all> [--dry-run]",
    handler: async (args, ctx) => {
      const arg = String(args || "").trim().toLowerCase();
      const parts = arg.split(/\s+/).filter(Boolean);
      const dryRun = parts.includes("--dry-run") || parts.includes("dry-run");
      const cleanParts = parts.filter((p) => p !== "--dry-run" && p !== "dry-run");
      const sub = cleanParts[0];

      if (sub === "check" || sub === "status") {
        const summary = await checkAddons(ctx);
        notify(ctx, "ai-addons check complete.", "info");
        return summary;
      }
      if (sub === "update" && cleanParts[1]) {
        const target = cleanParts.slice(1).join(" ");
        const results = [];
        if (target === "ponytail") {
          results.push(await updatePonytail(pi, ctx, dryRun));
        } else if (target === "rtk") {
          results.push(await updateRtk(ctx, dryRun));
        } else if (target === "caveman") {
          results.push(await updateCaveman(ctx, dryRun));
        } else if (target === "all") {
          notify(ctx, `ai-addons update all${dryRun ? " dry-run" : ""}: starting ponytail → rtk → caveman sequentially…`, "info");
          results.push(await updatePonytail(pi, ctx, dryRun));
          results.push(await updateRtk(ctx, dryRun));
          results.push(await updateCaveman(ctx, dryRun));
          if (!dryRun) results.push(RELOAD_MSG);
          notify(ctx, `ai-addons update all ${dryRun ? "dry-run " : ""}complete.${dryRun ? "" : ` ${RELOAD_MSG}`}`, "info");
        } else {
          const m = "Usage: /ai-addons update <ponytail|rtk|caveman|all> [--dry-run]";
          notify(ctx, m, "warning"); return m;
        }
        return results.join("\n\n");
      }

      const m = "Usage: /ai-addons <check|status|update ponytail|rtk|caveman|all> [--dry-run]";
      notify(ctx, m, "warning");
      return m;
    },
  });
}

