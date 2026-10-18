/**
 * ANSI → OpenTUI text bridge for the Subagent Activity page.
 *
 * The ported min-agent renderer produces ANSI rows (styles, 256-color panel
 * backgrounds, padded panel widths). OpenTUI's <text> takes styled spans, not
 * escape sequences, so this module renders the parsed SGR segments while
 * preserving every visible character and column.
 */
import { parseAnsiLine } from '../activity/ansi.js';

export { parseAnsiLine } from '../activity/ansi.js';

export function AnsiLine({ line, defaultColor, onMouseDown }: {
  line: string;
  defaultColor: string;
  onMouseDown?: () => void;
}) {
  const segments = parseAnsiLine(line);
  return (
    // selectable=false keeps a drag from becoming a full-width selection
    // highlight (which also swallowed tool-header clicks).
    <text fg={defaultColor} wrapMode="none" selectable={false} onMouseDown={onMouseDown}>
      {segments.length === 0 ? ' ' : segments.map((segment, index) => (
        <span
          key={index}
          fg={segment.fg}
          bg={segment.bg}
          attributes={segment.attributes || undefined}
        >
          {segment.text}
        </span>
      ))}
    </text>
  );
}

export function AnsiLines({ lines, defaultColor, toolHeaderLines, onToggleTool }: {
  lines: readonly string[];
  defaultColor: string;
  /** Global line index → tool block index; only header rows are clickable. */
  toolHeaderLines?: ReadonlyMap<number, number>;
  onToggleTool?: (blockIndex: number) => void;
}) {
  return (
    <>
      {lines.map((line, index) => {
        const blockIndex = toolHeaderLines?.get(index);
        return (
          // Fixed one-row boxes keep Yoga from stretching pre-wrapped rows
          // into multi-row gaps when the transcript overflows the viewport.
          <box key={index} width="100%" height={1} flexShrink={0} overflow="hidden">
            <AnsiLine
              line={line}
              defaultColor={defaultColor}
              onMouseDown={blockIndex !== undefined && onToggleTool ? () => onToggleTool(blockIndex) : undefined}
            />
          </box>
        );
      })}
    </>
  );
}
