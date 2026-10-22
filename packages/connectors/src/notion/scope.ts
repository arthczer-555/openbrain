import type { NotionClient } from "./client.ts";
import { normalizeId, pageTitle, type NotionDatabase, type NotionPage, type NotionParent } from "./types.ts";

// The integration must see the root page tree and nothing else: Notion
// bounds what an internal integration can read to the pages shared with it, so a page shared outside the tree
// is access the mirror does not need. Lists what the integration sees and walks each parent chain.

export interface OutsidePage {
  id: string;
  title: string;
  url?: string;
}

export interface ScopeCheck {
  visible: number;
  outside: OutsidePage[];
  /** True when the search hit its cap or the parent lookups ran out: the check is partial. */
  partial: boolean;
}

function parentId(parent: NotionParent | undefined): string | null {
  if (!parent) return null;
  const id = parent.page_id ?? parent.database_id ?? parent.data_source_id ?? parent.block_id;
  return id ? normalizeId(id) : null;
}

function titleOf(object: NotionPage | NotionDatabase): string {
  if (object.object === "page") return pageTitle(object);
  return object.title.map((t) => t.plain_text).join("") || "Untitled database";
}

export async function pagesOutsideTree(client: NotionClient, rootPageId: string, maxLookups = 200): Promise<ScopeCheck> {
  const root = normalizeId(rootPageId);
  const { results, truncated } = await client.search();
  const parents = new Map<string, string | null>();
  for (const object of results) parents.set(normalizeId(object.id), parentId(object.parent));

  const inside = new Map<string, boolean>([[root, true]]);
  let lookups = 0;
  let partial = truncated;

  const isInside = async (id: string, seen: Set<string>): Promise<boolean> => {
    const known = inside.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return false;
    seen.add(id);
    let parent = parents.get(id);
    if (parent === undefined) {
      // A parent the search did not return (a column, a toggle, a database): ask the block itself.
      if (lookups >= maxLookups) {
        partial = true;
        return true;
      }
      lookups++;
      try {
        parent = parentId((await client.getBlock(id)).parent);
      } catch {
        parent = null;
      }
      parents.set(id, parent);
    }
    const result = parent === null ? false : await isInside(parent, seen);
    inside.set(id, result);
    return result;
  };

  const outside: OutsidePage[] = [];
  for (const object of results) {
    const id = normalizeId(object.id);
    if (id === root || (await isInside(id, new Set()))) continue;
    outside.push({ id, title: titleOf(object), ...(object.url ? { url: object.url } : {}) });
  }
  return { visible: results.length, outside, partial };
}
