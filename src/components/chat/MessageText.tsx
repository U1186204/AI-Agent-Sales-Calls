import { Fragment, type ReactNode } from "react";
import { splitEmails } from "@/ui-lib/format";

/**
 * Renders assistant text as plain React text with light structure: blank-line paragraphs,
 * "- " / "* " / "• " bullet lists, "1. " numbered lists, and **bold**. Email addresses become
 * one-piece `mailto:` links (`.email`: never split mid-address, R2-6). Never uses
 * dangerouslySetInnerHTML — any HTML in the text is shown literally.
 */

type Block =
  | { type: "p"; lines: string[] }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] };

const BULLET = /^\s*(?:[-*•])\s+(.*)$/;
const NUMBER = /^\s*\d{1,3}[.)]\s+(.*)$/;

export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let cur: Block | null = null;
  const flush = () => {
    if (cur) blocks.push(cur);
    cur = null;
  };
  for (const line of lines) {
    if (line.trim() === "") {
      flush();
      continue;
    }
    const b = BULLET.exec(line);
    const n = b ? null : NUMBER.exec(line);
    if (b) {
      if (cur?.type !== "ul") {
        flush();
        cur = { type: "ul", items: [] };
      }
      cur.items.push(b[1] ?? "");
    } else if (n) {
      if (cur?.type !== "ol") {
        flush();
        cur = { type: "ol", items: [] };
      }
      cur.items.push(n[1] ?? "");
    } else if (cur && cur.type !== "p" && /^\s{2,}\S/.test(line)) {
      // Indented continuation of the previous list item.
      const items: string[] = cur.items;
      items[items.length - 1] = `${items[items.length - 1] ?? ""} ${line.trim()}`;
    } else {
      if (cur?.type !== "p") {
        flush();
        cur = { type: "p", lines: [] };
      }
      cur.lines.push(line.trim());
    }
  }
  flush();
  return blocks;
}

function withEmails(text: string): ReactNode {
  return splitEmails(text).map((p, i) =>
    p.email ? (
      <a key={i} className="email" href={`mailto:${p.text}`}>
        {p.text}
      </a>
    ) : (
      <Fragment key={i}>{p.text}</Fragment>
    ),
  );
}

function inline(text: string): ReactNode {
  const parts = text.split(/(\*\*[^*\n]+\*\*)/g);
  return parts.map((part, i) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
      <strong key={i}>{withEmails(part.slice(2, -2))}</strong>
    ) : (
      <Fragment key={i}>{withEmails(part)}</Fragment>
    ),
  );
}

export function MessageText({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  return (
    <>
      {blocks.map((block, i) => {
        if (block.type === "p") {
          return (
            <p key={i}>
              {block.lines.map((l, j) => (
                <Fragment key={j}>
                  {j > 0 && <br />}
                  {inline(l)}
                </Fragment>
              ))}
            </p>
          );
        }
        const Tag = block.type;
        return (
          <Tag key={i}>
            {block.items.map((item, j) => (
              <li key={j}>{inline(item)}</li>
            ))}
          </Tag>
        );
      })}
    </>
  );
}
