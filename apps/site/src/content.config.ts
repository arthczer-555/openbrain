import { defineCollection } from "astro:content";
import { z } from "astro/zod";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

// Starlight serves src/content/docs/**. Pages live under src/content/docs/docs/ so the docs are served at
// /docs/... and the custom landing page keeps "/".
// `lang` lets a single page be written in another language (for example a page in French) without setting up a
// whole second locale: src/route-data.ts applies it to the <html lang> attribute.
export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema({ extend: z.object({ lang: z.string().optional() }) }),
  }),
};
