// Rough language detection for reports and the retrieval-first marker message, without a library:
// counts frequent function words. Answers themselves follow the question through the core prompt.

const FRENCH = new Set(
  "le la les un une des du de au aux et est sont pour dans sur avec comment quel quelle quels quelles pourquoi qui que quoi combien nous notre vous votre ce cette ces il elle on pas ne faut peut est-ce".split(" "),
);
const ENGLISH = new Set(
  "the a an and is are for in on with how what which why who whom whose we our you your this that these it not do does can should when where".split(" "),
);

export function detectLanguage(text: string): "fr" | "en" | "other" {
  const words = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .split(/[^a-z'-]+/)
    .filter(Boolean);
  let fr = /[éèêàùçœ]/i.test(text) ? 2 : 0;
  let en = 0;
  for (const word of words) {
    if (FRENCH.has(word)) fr++;
    if (ENGLISH.has(word)) en++;
  }
  if (fr === 0 && en === 0) return "other";
  return fr > en ? "fr" : "en";
}
