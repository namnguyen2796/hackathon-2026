import { SearchIndexClient, AzureKeyCredential } from "@azure/search-documents";

/** What every caller (rag-api, suggest_changes, ask_documents) references. It is an alias, not
 *  a physical index — reindexing alternates between the two physical names below and flips the
 *  alias only once the new content is fully uploaded. */
export const ALIAS = "doc-hierarchy-index";
export const PHYSICAL_INDEXES = ["doc-hierarchy-index-blue", "doc-hierarchy-index-green"] as const;

let cached: SearchIndexClient | undefined;

/** Built on first use, not at module load: dotenv runs in the entry module's *body*, which is
 *  after every import it declares has already been evaluated. */
export function indexClient(): SearchIndexClient {
  cached ??= new SearchIndexClient(
    process.env.AZURE_SEARCH_ENDPOINT!,
    new AzureKeyCredential(process.env.AZURE_SEARCH_KEY!)
  );
  return cached;
}

/** live = whatever the alias currently points at; staging = the other one of the fixed pair. */
export async function getLiveAndStagingIndexNames(): Promise<{ live: string; staging: string }> {
  let live: string;
  try {
    live = (await indexClient().getAlias(ALIAS)).indexes[0];
  } catch (err) {
    throw new Error(
      `Could not read the alias "${ALIAS}" — has the one-time migration been run ` +
      `(npm run doc-hierarchy:migrate-alias)? (${(err as Error).message})`
    );
  }
  const staging = PHYSICAL_INDEXES.find(name => name !== live);
  if (!staging) {
    throw new Error(
      `Alias "${ALIAS}" points at "${live}", which is not one of ${PHYSICAL_INDEXES.join(" / ")}.`
    );
  }
  return { live, staging };
}

/** The single atomic moment the new content starts being served. */
export async function swapAliasToStaging(staging: string): Promise<void> {
  await indexClient().createOrUpdateAlias({ name: ALIAS, indexes: [staging] });
}
