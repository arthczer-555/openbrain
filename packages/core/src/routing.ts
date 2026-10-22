import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { formatIssues } from "./frontmatter.ts";

// brain/registry.yaml: the routing registry of the agent, maintained by the weekly update (and by hand when
// needed), the way the page registry of the original agent guide was. One entry per Notion page that holds
// knowledge, one entry per section. It says WHEN to open a page, never what the page contains.

export const ROUTING_FILE = "brain/registry.yaml";

export const DocStatusSchema = z.enum(["validated", "to_confirm", "stale"]);
export type DocStatus = z.infer<typeof DocStatusSchema>;

export const DocRoutingSchema = z
  .object({
    when_to_open: z.string().min(1),
    aliases: z.array(z.string().min(1)).default([]),
    warnings: z.array(z.string().min(1)).default([]),
    status: DocStatusSchema.default("validated"),
  })
  .strict();

export const SectionRoutingSchema = z
  .object({
    description: z.string().min(1),
    rules: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const RoutingRegistrySchema = z
  .object({
    version: z.literal(1).default(1),
    sections: z.record(z.string().min(1), SectionRoutingSchema).default({}),
    docs: z.record(z.string().min(1), DocRoutingSchema).default({}),
  })
  .strict();

export type DocRouting = z.infer<typeof DocRoutingSchema>;
export type SectionRouting = z.infer<typeof SectionRoutingSchema>;
export type RoutingRegistry = z.infer<typeof RoutingRegistrySchema>;

export interface RoutingLoad {
  /** Null when the file is missing or invalid. */
  registry: RoutingRegistry | null;
  present: boolean;
  errors: string[];
}

export function parseRoutingRegistry(text: string): { registry: RoutingRegistry | null; errors: string[] } {
  let data: unknown;
  try {
    data = parseYaml(text) ?? {};
  } catch (error) {
    return { registry: null, errors: [`invalid YAML: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const result = RoutingRegistrySchema.safeParse(data);
  if (!result.success) return { registry: null, errors: formatIssues(result.error) };
  return { registry: result.data, errors: [] };
}

export async function loadRoutingRegistry(root: string): Promise<RoutingLoad> {
  let text: string;
  try {
    text = await readFile(path.join(root, ROUTING_FILE), "utf8");
  } catch {
    return { registry: null, present: false, errors: [] };
  }
  const { registry, errors } = parseRoutingRegistry(text);
  return { registry, present: true, errors };
}
