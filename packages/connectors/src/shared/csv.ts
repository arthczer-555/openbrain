import { markdownTable } from "../notion/render.ts";

// CSV / TSV to a Markdown table (RFC 4180 quoting, delimiter guessed from the first line), capped in rows
// so a large export does not flood the weekly packet.

export const DEFAULT_MAX_TABLE_ROWS = 200;

function guessDelimiter(text: string): string {
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const counts = [",", ";", "\t", "|"].map((d) => ({ d, n: firstLine.split(d).length - 1 }));
  counts.sort((a, b) => b.n - a.n);
  return counts[0] && counts[0].n > 0 ? counts[0].d : ",";
}

export function parseCsv(text: string, delimiter = guessDelimiter(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const source = text.replace(/^\ufeff/, "");
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field === "") {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

function escapeCell(cell: string): string {
  return cell.replace(/\s*\r?\n\s*/g, " ").replace(/\|/g, "\\|").trim();
}

export interface CsvTable {
  markdown: string;
  rows: number;
  truncated: boolean;
}

/** Header row + at most `maxRows` data rows; a final note tells how many rows were left out. */
export function csvToMarkdown(text: string, maxRows = DEFAULT_MAX_TABLE_ROWS): CsvTable {
  const rows = parseCsv(text);
  if (rows.length === 0) return { markdown: "", rows: 0, truncated: false };
  const [header = [], ...data] = rows;
  const kept = data.slice(0, maxRows);
  const table = markdownTable([header, ...kept].map((r) => r.map(escapeCell)));
  const truncated = data.length > kept.length;
  const note = truncated ? `\n\n(${data.length - kept.length} more rows not shown, ${data.length} in total)` : "";
  return { markdown: `${table}${note}`, rows: data.length, truncated };
}
