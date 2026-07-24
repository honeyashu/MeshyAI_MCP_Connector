/**
 * Attrangi Studio — character preview generator (library path).
 *
 * Drives the connector directly, bypassing the MCP transport, which currently
 * returns "fetch failed" from the Claude-spawned process even though the same
 * calls succeed from a normal shell. The API key is loaded from the encrypted
 * keystore by CredentialManager and never printed.
 *
 * Usage:  node attrangi-generate.mjs <slug>
 * Prompts live in PROMPTS below, each built on the PLAN-26 §5 Kissago anchor
 * (AMD-15 Form 1) so the roster stays in one visual world.
 */

import { CredentialManager } from "./dist/core/CredentialManager.js";
import { MeshyProvider } from "./dist/providers/meshy/MeshyProvider.js";
import { GenerationManager } from "./dist/core/GenerationManager.js";

// Meshy caps prompts at 600 chars — these are tuned to fit.
const PROMPTS = {
  kachhua:
    "Adorable collectible designer-toy 3D render of a storyteller tortoise. " +
    "Chunky rounded vinyl-toy proportions, oversized head ~40% of height, " +
    "domed segmented shell, stubby fused legs. Deep teal shell, soft ochre " +
    "plastron, amber underbelly. Large round amber eyes with soft catchlights, " +
    "friendly. Tiny saffron fabric scarf at the neck. Smooth matte resin vinyl, " +
    "sheen on eyes only. Single hero pose, three-quarter view, sitting upright, " +
    "head raised listening. Soft studio lighting, plain warm cream background, " +
    "centered, no text. NOT flat illustration, NOT cartoon, NOT low-poly.",
};

const slug = process.argv[2];
const prompt = PROMPTS[slug];
if (!prompt) {
  console.error(`Unknown slug "${slug}". Known: ${Object.keys(PROMPTS).join(", ")}`);
  process.exit(1);
}
console.log(`prompt length: ${prompt.length} chars (Meshy cap 600)`);
if (prompt.length > 600) {
  console.error("Prompt exceeds Meshy's 600-char cap — trim before spending credits.");
  process.exit(1);
}

const apiKey = await new CredentialManager().loadCredentials("meshy");
if (!apiKey) {
  console.error("No stored credential. Run save-key.mjs first.");
  process.exit(1);
}

const provider = new MeshyProvider(apiKey, 60000);
const gen = new GenerationManager(provider);

const before = await provider.getBalance?.().catch(() => null);
if (before != null) console.log(`balance before: ${before} credits`);

console.log(`\nsubmitting PREVIEW (untextured, cheapest pass) for "${slug}"…`);
// NOTE: MESHY_CONNECTOR.md documents modelType as 'standard'|'cute'|'realastic',
// but the live v2 endpoint rejects those — it accepts only [standard, lowpoly].
// Verified 2026-07-24 (HTTP 400). Connector docs need correcting.
const taskId = await gen.textToPreview({ prompt, modelType: "standard" });
console.log(`task id: ${taskId}`);

// Poll until terminal.
const started = Date.now();
let last = "";
for (;;) {
  const st = await gen.getJobStatus(taskId);
  const line = `${st.status}${st.progress != null ? ` ${st.progress}%` : ""}`;
  if (line !== last) {
    console.log(`  [${Math.round((Date.now() - started) / 1000)}s] ${line}`);
    last = line;
  }
  const s = String(st.status).toLowerCase();
  if (s.includes("succeed") || s.includes("complete")) {
    console.log("\nPREVIEW COMPLETE");
    console.log(JSON.stringify(st, null, 2).slice(0, 2500));
    break;
  }
  if (s.includes("fail") || s.includes("cancel") || s.includes("error")) {
    console.log("\nFAILED / CANCELLED");
    console.log(JSON.stringify(st, null, 2).slice(0, 1500));
    break;
  }
  if (Date.now() - started > 10 * 60 * 1000) {
    console.log("\nTimed out after 10 min — task may still be running.");
    console.log(`Re-check later with task id ${taskId}`);
    break;
  }
  await new Promise((r) => setTimeout(r, 5000));
}

const after = await provider.getBalance?.().catch(() => null);
if (after != null) {
  console.log(`\nbalance after: ${after} credits` + (before != null ? ` (spent ${before - after})` : ""));
}
