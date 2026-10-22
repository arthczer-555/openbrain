import { defineRouteMiddleware } from "@astrojs/starlight/route-data";

// A page can declare `lang: fr` in its frontmatter (see src/content.config.ts): the document language is then
// set accordingly, so screen readers and translation tools read it in the right language.
export const onRequest = defineRouteMiddleware((context) => {
  const route = context.locals.starlightRoute;
  const lang = route.entry.data.lang;
  if (typeof lang === "string" && lang.length > 0) {
    route.lang = lang;
  }
});
