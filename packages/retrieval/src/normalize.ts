// Text normalization for BM25F: lowercase, accents removed, short FR/EN stopword list, light plural folding.
// Kept deliberately small: aliases in the frontmatter and query rewriting by the model do the heavy lifting.

const STOPWORDS = new Set(
  [
    // English
    "a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "does", "for", "from", "how", "i", "if",
    "in", "into", "is", "it", "its", "me", "my", "of", "on", "or", "our", "so", "that", "the", "their",
    "them", "then", "there", "this", "to", "us", "was", "we", "what", "when", "where", "which", "who",
    "why", "will", "with", "you", "your",
    // French (accents already removed)
    "au", "aux", "avec", "ce", "ces", "comment", "dans", "de", "des", "du", "elle", "en", "est", "et",
    "il", "je", "la", "le", "les", "leur", "ma", "mais", "me", "mes", "mon", "ne", "nos", "notre", "nous",
    "on", "ou", "par", "pas", "pour", "qu", "que", "quel", "quelle", "qui", "sa", "se", "ses", "son",
    "sur", "ta", "te", "tes", "ton", "tu", "un", "une", "vos", "votre", "vous",
  ],
);

export function foldAccents(text: string): string {
  return text.normalize("NFD").replace(/\p{M}+/gu, "");
}

/** Light plural folding shared by both languages: users -> user, comptes -> compte. */
function fold(token: string): string {
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const raw of foldAccents(text).toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    tokens.push(fold(raw));
  }
  return tokens;
}
