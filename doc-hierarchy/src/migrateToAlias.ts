import { config } from "dotenv";
config({ path: new URL("../../.env", import.meta.url), quiet: true });

import { ALIAS, PHYSICAL_INDEXES, indexClient } from "./indexAlias.js";
import { ensureIndex } from "./createIndex.js";
import { seedIndex } from "./ingest.js";

const [BLUE, GREEN] = PHYSICAL_INDEXES;

async function exists(get: () => Promise<unknown>): Promise<boolean> {
  try {
    await get();
    return true;
  } catch {
    return false;
  }
}

/**
 * One-time migration from a physical index literally named `doc-hierarchy-index` to an alias of
 * that name pointing at one of two fixed physical indexes. Idempotent: re-running once the alias
 * exists does nothing, so it is safe to leave wired to an npm script.
 *
 * The order below is dictated by the index quota, which on this service is 3 with `docs-index`
 * already holding one slot. Blue is created and seeded while the old index is still serving, the
 * old index is then dropped to free both its slot and its name, and only then is green created.
 * Never more than 3 indexes exist at once, and no point in the sequence has doc-hierarchy content
 * missing from the service.
 */
async function migrate(): Promise<void> {
  if (await exists(() => indexClient().getAlias(ALIAS))) {
    console.log(`Alias "${ALIAS}" already exists — nothing to migrate.`);
    return;
  }

  const { indexCounter } = (await indexClient().getServiceStatistics()).counters;
  if (indexCounter.quota !== null && indexCounter.quota < 3) {
    throw new Error(
      `This service allows ${indexCounter.quota} index(es); blue/green reindexing needs 2 of them.`
    );
  }

  await ensureIndex(BLUE);
  await seedIndex(BLUE);

  // An alias cannot share its name with a physical index, so the old one has to go. Only
  // reachable here because the alias doesn't exist yet, so this name can't resolve through one.
  if (await exists(() => indexClient().getIndex(ALIAS))) {
    await indexClient().deleteIndex(ALIAS);
    console.log(`Deleted the old physical index "${ALIAS}" (its content is now in ${BLUE}).`);
  }

  await ensureIndex(GREEN);
  await indexClient().createOrUpdateAlias({ name: ALIAS, indexes: [BLUE] });
  console.log(`Alias "${ALIAS}" -> ${BLUE}. Alias changes can take a few seconds to propagate.`);
}

await migrate();
