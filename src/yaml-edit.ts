import { type Document, parseDocument } from "yaml";

const FORMATS = [
  { lineWidth: 0, indentSeq: false },
  { lineWidth: 0, indentSeq: true },
] as const;

/**
 * Parses `text`, lets `change` edit the document, and writes it back with
 * its comments, its scalar styles, and the list indentation the file uses.
 * A file that mixes list indentations is written with the one that rewrites
 * fewer of its lines.
 */
export function editYamlText(
  text: string,
  change: (doc: Document) => void,
): string {
  const doc = parseDocument(text, { version: "1.1" });
  const changedLines = (format: (typeof FORMATS)[number]) => {
    const lines = new Set(text.split("\n"));
    return doc
      .toString(format)
      .split("\n")
      .filter((line) => !lines.has(line)).length;
  };
  const [format] = [...FORMATS].sort(
    (a, b) => changedLines(a) - changedLines(b),
  );
  change(doc);
  return doc.toString(format);
}
