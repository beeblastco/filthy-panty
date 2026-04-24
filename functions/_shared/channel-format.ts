/**
 * Channel-specific text formatting helpers.
 * Normalize generic markdown-ish assistant output for Slack, Discord, and Telegram.
 */

export interface MarkdownTable {
  rows: string[][];
}

interface SlackRawTextCell {
  type: "raw_text";
  text: string;
}

interface SlackTableBlock {
  type: "table";
  rows: SlackRawTextCell[][];
  column_settings?: Array<{ align?: "left" | "center" | "right"; is_wrapped?: boolean } | null>;
}

interface SlackAttachment {
  blocks: SlackTableBlock[];
}

export interface SlackFormattedMessage {
  text: string;
  attachments?: SlackAttachment[];
}

export function formatSlackMessage(text: string): SlackFormattedMessage {
  const extracted = extractMarkdownTables(text);

  if (extracted.tables.length === 1) {
    return {
      text: transformSlackLines(extracted.text).trim() || " ",
      attachments: [{ blocks: [toSlackTableBlock(extracted.tables[0]!)] }],
    };
  }

  return {
    text: transformNonCodeSegments(text, (segment) =>
      transformSlackLines(replaceMarkdownTables(segment, (table) => renderMonospaceTable(table))),
    ).trim(),
  };
}

export function formatDiscordMessage(text: string): string {
  return transformNonCodeSegments(
    text,
    (segment) => replaceMarkdownTables(segment, (table) => renderMonospaceTable(table)),
  ).trim();
}

export function formatTelegramHtml(text: string): string {
  const result: string[] = [];
  let lastIndex = 0;
  const pattern = /```(\w*)\n?([\s\S]*?)```/g;

  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      result.push(formatTelegramSegment(text.slice(lastIndex, index)));
    }

    const language = (match[1] ?? "").trim();
    const code = escapeHtml((match[2] ?? "").trimEnd());
    result.push(
      language
        ? `<pre><code class="language-${language}">${code}</code></pre>`
        : `<pre>${code}</pre>`,
    );
    lastIndex = index + match[0].length;
  }

  if (lastIndex < text.length) {
    result.push(formatTelegramSegment(text.slice(lastIndex)));
  }

  return result.join("");
}

function transformNonCodeSegments(
  text: string,
  formatter: (segment: string) => string,
): string {
  const parts: string[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(/```[\s\S]*?```/g)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      parts.push(formatter(text.slice(lastIndex, index)));
    }

    parts.push(match[0]);
    lastIndex = index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(formatter(text.slice(lastIndex)));
  }

  return parts.join("");
}

function extractMarkdownTables(text: string): { text: string; tables: MarkdownTable[] } {
  const tables: MarkdownTable[] = [];
  const stripped = transformNonCodeSegments(
    text,
    (segment) => replaceMarkdownTables(segment, (table) => {
      tables.push(table);
      return "";
    }),
  );

  return {
    text: collapseBlankLines(stripped),
    tables,
  };
}

function replaceMarkdownTables(
  text: string,
  renderTable: (table: MarkdownTable) => string,
): string {
  const lines = text.split("\n");
  const output: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (
      isMarkdownTableRow(lines[index]) &&
      index + 1 < lines.length &&
      isMarkdownTableSeparator(lines[index + 1])
    ) {
      const tableLines = [lines[index]!, lines[index + 1]!];
      index += 2;

      while (index < lines.length && isMarkdownTableRow(lines[index])) {
        tableLines.push(lines[index]!);
        index += 1;
      }

      index -= 1;
      const table = parseMarkdownTable(tableLines);
      output.push(table ? renderTable(table) : tableLines.join("\n"));
      continue;
    }

    output.push(lines[index]!);
  }

  return output.join("\n");
}

function parseMarkdownTable(lines: string[]): MarkdownTable | null {
  const rows = lines
    .filter((line) => !isMarkdownTableSeparator(line))
    .map((line) => parseMarkdownTableRow(line));

  return rows.length > 0 ? { rows } : null;
}

function renderMonospaceTable(table: MarkdownTable): string {
  const plainTable = toPlainTextTable(table);
  const { widths } = getTableMetrics(plainTable);
  const renderRow = (row: string[]) =>
    row
      .map((cell, columnIndex) => (cell ?? "").padEnd(widths[columnIndex]!))
      .join(" | ");

  const header = renderRow(plainTable.rows[0]!);
  const separator = widths.map((width) => "-".repeat(width)).join("-|-");
  const body = plainTable.rows.slice(1).map((row) => renderRow(row));

  return `\`\`\`text\n${[header, separator, ...body].join("\n")}\n\`\`\``;
}

function renderBoxTable(table: MarkdownTable): string {
  const plainTable = toPlainTextTable(table);
  const { columnCount, widths } = getTableMetrics(plainTable);
  const rule = (left: string, middle: string, right: string, fill: string) =>
    left + widths.map((width) => fill.repeat(width + 2)).join(middle) + right;

  const renderRow = (row: string[]) =>
    "│" +
    Array.from({ length: columnCount }, (_, columnIndex) => {
      const cell = columnIndex < row.length ? row[columnIndex]! : "";
      return ` ${cell.padEnd(widths[columnIndex]!)} `;
    }).join("│") +
    "│";

  const output = [rule("┌", "┬", "┐", "─"), renderRow(plainTable.rows[0]!)];
  if (plainTable.rows.length > 1) {
    output.push(rule("├", "┼", "┤", "─"));
    for (const row of plainTable.rows.slice(1)) {
      output.push(renderRow(row));
    }
  }
  output.push(rule("└", "┴", "┘", "─"));
  return output.join("\n");
}

function formatTelegramSegment(text: string): string {
  const parts: string[] = [];
  const lines = text.split("\n");
  const pending: string[] = [];

  const flushPending = () => {
    if (pending.length === 0) {
      return;
    }

    parts.push(inlineToTelegramHtml(pending.join("\n")));
    pending.length = 0;
  };

  for (let index = 0; index < lines.length; index += 1) {
    if (
      isMarkdownTableRow(lines[index]) &&
      index + 1 < lines.length &&
      isMarkdownTableSeparator(lines[index + 1])
    ) {
      const tableLines = [lines[index]!, lines[index + 1]!];
      index += 2;

      while (index < lines.length && isMarkdownTableRow(lines[index])) {
        tableLines.push(lines[index]!);
        index += 1;
      }

      index -= 1;
      flushPending();
      const table = parseMarkdownTable(tableLines);
      parts.push(table ? `<pre>${escapeHtml(renderBoxTable(table))}</pre>` : escapeHtml(tableLines.join("\n")));
      continue;
    }

    pending.push(lines[index]!);
  }

  flushPending();
  return parts.join("");
}

function getTableMetrics(table: MarkdownTable): { columnCount: number; widths: number[] } {
  const columnCount = Math.max(...table.rows.map((row) => row.length));
  const widths = Array.from({ length: columnCount }, (_, columnIndex) =>
    Math.max(...table.rows.map((row) => (row[columnIndex] ?? "").length), 3),
  );

  return { columnCount, widths };
}

function transformSlackLines(text: string): string {
  return collapseBlankLines(
    text
      .split("\n")
      .map((line) => formatSlackLine(line))
      .join("\n"),
  );
}

function formatSlackLine(line: string): string {
  if (/^\s*---+\s*$/.test(line)) {
    return "";
  }

  const headingMatch = line.match(/^(\s*)#{1,6}\s+(.+)$/);
  if (headingMatch) {
    return `${headingMatch[1]}*${stripSlackHeadingMarkup(headingMatch[2]!.trim())}*`;
  }

  const bulletMatch = line.match(/^(\s*)[*-]\s+(.+)$/);
  if (bulletMatch) {
    return `${bulletMatch[1]}• ${formatSlackInline(bulletMatch[2]!)}`;
  }

  return formatSlackInline(line);
}

function formatSlackInline(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/__(.+?)__/g, "*$1*");
}

function stripSlackHeadingMarkup(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .trim();
}

function toSlackTableBlock(table: MarkdownTable): SlackTableBlock {
  const { columnCount } = getTableMetrics(table);
  const plainTable = toPlainTextTable(table);

  return {
    type: "table",
    column_settings: Array.from({ length: columnCount }, (_, index) => (
      index === 0
        ? { is_wrapped: true }
        : null
    )),
    rows: plainTable.rows.map((row) =>
      Array.from({ length: columnCount }, (_, columnIndex) => ({
        type: "raw_text" as const,
        text: row[columnIndex] ?? "",
      })),
    ),
  };
}

function stripMarkdownEmphasis(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "$1")
    .replace(/(?<!_)_(?!_)([^_\n]+)_(?!_)/g, "$1")
    .replace(/`(.+?)`/g, "$1");
}

function toPlainTextTable(table: MarkdownTable): MarkdownTable {
  return {
    rows: table.rows.map((row) => row.map((cell) => stripMarkdownEmphasis(cell))),
  };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inlineToTelegramHtml(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
      if (headingMatch) {
        return `<b>${escapeHtml(headingMatch[1]!)}</b>`;
      }

      return line
        .split(/(`[^`\n]+`)/)
        .map((part) => {
          if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
            return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
          }
          return richToTelegramHtml(part);
        })
        .join("");
    })
    .join("\n");
}

function richToTelegramHtml(text: string): string {
  const parts: string[] = [];
  for (const part of text.split(/(\[[^\]]+\]\([^)]+\))/)) {
    const linkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (linkMatch) {
      const href = linkMatch[2]!;
      if (/^https?:\/\//i.test(href)) {
        parts.push(`<a href="${escapeHtml(href)}">${escapeHtml(linkMatch[1]!)}</a>`);
      } else {
        parts.push(escapeHtml(part));
      }
    } else {
      let escaped = escapeHtml(part);
      escaped = escaped.replace(/\*\*(.+?)\*\*/gs, "<b>$1</b>");
      escaped = escaped.replace(/__(.+?)__/gs, "<b>$1</b>");
      escaped = escaped.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");
      escaped = escaped.replace(/(?<!_)_(?!_)([^_\n]+)_(?!_)/g, "<i>$1</i>");
      parts.push(escaped);
    }
  }
  return parts.join("");
}

function collapseBlankLines(text: string): string {
  return text
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n");
}

function parseMarkdownTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isMarkdownTableRow(line: string | undefined): boolean {
  return typeof line === "string"
    && /^\s*\|.*\|\s*$/.test(line)
    && line.includes("|");
}

function isMarkdownTableSeparator(line: string | undefined): boolean {
  return typeof line === "string"
    && /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(line);
}
