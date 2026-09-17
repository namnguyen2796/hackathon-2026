import { config } from "dotenv";
config({ path: new URL("../../.env", import.meta.url), quiet: true });

import { applyServerEnvDefaults } from "./serverEnv.js";
import { reindexCurrentDraft } from "./draftIndex.js";

applyServerEnvDefaults();
await reindexCurrentDraft();
