/**
 * One-time Meshy API key setup — run this yourself, in your own terminal.
 *
 * WHY THIS EXISTS: the connector's `save_credentials` MCP tool works, but using
 * it means pasting your `msy_...` key into a chat message, where it becomes part
 * of the conversation transcript. Claude will not enter API keys into fields for
 * exactly that reason. This script does the identical thing — same
 * CredentialManager, same AES-256-GCM encrypted store at ~/.meshy-connector —
 * but the key goes straight from your shell into the keystore and is never seen
 * by anyone else.
 *
 * USAGE (PowerShell):
 *   $env:MESHY_API_KEY = "msy_your_key_here"
 *   node save-key.mjs
 *   Remove-Item Env:\MESHY_API_KEY
 *
 * Then, back in the Claude session, just say "test the meshy connection" —
 * `test_connection` and `get_balance` read the stored key on their own and need
 * no secret passed to them.
 */

import { CredentialManager } from "./dist/core/CredentialManager.js";

const key = process.env.MESHY_API_KEY;

if (!key) {
  console.error(
    "MESHY_API_KEY is not set.\n\n" +
      'PowerShell:  $env:MESHY_API_KEY = "msy_..."; node save-key.mjs\n' +
      "bash:        MESHY_API_KEY=msy_... node save-key.mjs\n",
  );
  process.exit(1);
}

if (!/^msy_/.test(key)) {
  console.error(
    "That does not look like a Meshy key — it should start with 'msy_'.\n" +
      "Get one at https://www.meshy.ai/api-keys",
  );
  process.exit(1);
}

try {
  await new CredentialManager().saveCredentials("meshy", key);
  console.log("Saved. Key is encrypted at ~/.meshy-connector/credentials.json");
  console.log("Now clear the variable:  Remove-Item Env:\\MESHY_API_KEY");
  console.log('Then in Claude, say: "test the meshy connection"');
} catch (err) {
  console.error("Failed to save:", err.message);
  process.exit(1);
}
