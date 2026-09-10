// ------------------------------------------------------------------
// Paste content format (v3 — unified editor).
//
// The creation flow is ONE editor producing ONE document: a JSON-encoded
// `RichDoc` stored under format 'rich'. Plain text is simply a RichDoc
// whose lines carry no styling/marks, so text, code (mono font), links,
// headings/lists (per-line size) and rich formatting all coexist in a
// single paste — no mode toggle is needed at creation time.
//
// Legacy storage formats (still rendered, never created by the unified
// editor):
//
//   "plain"  — a plain string. Rendered with the existing viewer
//              (highlight.js + line numbers). Links are auto-linked.
//
//   "rich"   — a JSON-encoded `RichDoc` (see below). Allows per-line
//              formatting (font, size, color) plus inline tokens
//              (emoji, sticker, link). Always rendered through
//              <RichPasteView> which links URLs but never previews.
//
// Backward compatibility: every read path (viewer page, raw/download,
// unlock) accepts both shapes; `parsePasteContent` falls back to the
// raw string if a 'rich' row does not parse as a valid RichDoc.
// ------------------------------------------------------------------

import type { ReactNode } from 'react';

export type InlineMark = {
  /** [start, end) character offsets within the line. */
  start: number;
  end: number;
  /** 'link' | 'sticker' | 'emoji'. */
  kind: 'link' | 'sticker' | 'emoji';
  /** link -> url, sticker -> token, emoji -> native emoji char. */
  value: string;
};

export type RichLine = {
  text: string;
  font?: string; // CSS font-family, e.g. "Inter, sans-serif"
  size?: number; // px
  color?: string; // hex
  marks?: InlineMark[]; // sorted, non-overlapping
  /**
   * Client-side only: a stable identity used as the React key for the
   * composer's uncontrolled contentEditable lines. Stripped before the doc
   * is stored (see Editor.submit), so it never reaches the database.
   */
  _key?: string;
  /**
   * Optional explicit url for sticker tokens in this line, keyed by the
   * shortcode (e.g. ":anime-hug:" → gif url). Lets the composer embed a
   * sticker/GIF that isn't in the DB pack (e.g. a live anime GIF) and
   * still render reliably in the final paste. Serially saved in the doc.
   */
  stickerUrls?: Record<string, string>;
};

export type RichDoc = { v: 1; lines: RichLine[] };

export const RICH_VERSION = 1 as const;

/** Type guards used by both the server and the client. */
export function isRichDoc(value: unknown): value is RichDoc {
  if (!value || typeof value !== 'object') return false;
  const d = value as Record<string, unknown>;
  if (d.v !== 1) return false;
  if (!Array.isArray(d.lines)) return false;
  return d.lines.every(
    (l) =>
      l && typeof l === 'object' && typeof (l as RichLine).text === 'string',
  );
}

export function parsePasteContent(format: string, content: string): RichDoc | string {
  if (format === 'rich') {
    try {
      const parsed = JSON.parse(content);
      if (isRichDoc(parsed)) return parsed;
    } catch {
      /* fall through to plain */
    }
    return content;
  }
  return content;
}

/**
 * Flattens a RichDoc back to plain text (one line per doc line; sticker /
 * emoji shortcodes stay as their literal text, links keep their URL text).
 * Used by raw/download, "Copy content" and the paste page — anything that
 * needs the readable text of a unified paste regardless of formatting.
 */
export function richDocToPlainText(doc: RichDoc): string {
  return doc.lines.map((l) => l.text ?? '').join('\n');
}

/**
 * True when a doc carries actual rich formatting — a per-line font, size,
 * color, or a sticker/emoji token mark. Auto-detected link marks do NOT
 * count: the plain viewer auto-links URLs too, so a paste that merely
 * contains a URL is not "richer" than a plain paste. Lets the UI badge
 * genuinely formatted pastes without reintroducing a Text/Rich mode.
 */
export function hasRichFormatting(doc: RichDoc | string): boolean {
  if (typeof doc === 'string') return false;
  return doc.lines.some(
    (l) =>
      l.font !== undefined ||
      l.size !== undefined ||
      l.color !== undefined ||
      (l.marks ?? []).some((m) => m.kind === 'sticker' || m.kind === 'emoji'),
  );
}

/**
 * True when rendering the doc would mount at least one sticker (a line
 * with a `sticker` mark that survives the same `sanitizeMarks` pass the
 * renderer applies). The paste page uses this to decide whether the
 * server sticker pack is needed at all: plain-text pastes and rich docs
 * without stickers render identically without it. Emoji and link marks
 * never need the pack.
 */
export function richDocHasStickerMarks(doc: RichDoc | string): boolean {
  if (typeof doc === 'string') return false;
  return doc.lines.some((l) =>
    sanitizeMarks(l.marks, (l.text ?? '').length).some((m) => m.kind === 'sticker'),
  );
}

const FONT_OPTIONS = [
  { id: 'normal', label: 'Normal', css: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif' },
  { id: 'sans', label: 'Sans', css: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  { id: 'mono', label: 'Mono', css: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace' },
  { id: 'serif', label: 'Serif', css: 'ui-serif, Georgia, Cambria, "Times New Roman", serif' },
  { id: 'rounded', label: 'Rounded', css: '"Nunito", "SF Pro Rounded", system-ui, sans-serif' },
  { id: 'condensed', label: 'Narrow', css: '"Roboto Condensed", "Arial Narrow", sans-serif' },
  { id: 'display', label: 'Display', css: '"Bebas Neue", "Anton", Impact, sans-serif' },
  { id: 'times', label: 'Times', css: '"Times New Roman", Times, serif' },
  { id: 'georgia', label: 'Georgia', css: 'Georgia, Cambria, "Times New Roman", serif' },
  { id: 'palatino', label: 'Palatino', css: '"Palatino Linotype", Palatino, "Book Antiqua", serif' },
  { id: 'typewriter', label: 'Typewriter', css: '"Courier New", Courier, monospace' },
  { id: 'comic', label: 'Comic', css: '"Comic Sans MS", "Comic Sans", "Chalkboard SE", cursive' },
  { id: 'handwritten', label: 'Handwritten', css: '"Segoe Script", "Bradley Hand", "Brush Script MT", cursive' },
  { id: 'verdana', label: 'Verdana', css: 'Verdana, Geneva, Tahoma, sans-serif' },
  { id: 'trebuchet', label: 'Trebuchet', css: '"Trebuchet MS", "Lucida Grande", sans-serif' },
  { id: 'arial', label: 'Arial', css: 'Arial, Helvetica, sans-serif' },
  { id: 'tahoma', label: 'Tahoma', css: 'Tahoma, Geneva, Verdana, sans-serif' },
  { id: 'calibri', label: 'Calibri', css: 'Calibri, "Segoe UI", Arial, sans-serif' },
  { id: 'impact', label: 'Impact', css: 'Impact, "Haettenschweiler", "Arial Narrow Bold", sans-serif' },
  { id: 'franklin', label: 'Franklin', css: '"Franklin Gothic Medium", "Arial Narrow", sans-serif' },
  { id: 'fantasy', label: 'Fantasy', css: 'Papyrus, Copperplate, fantasy' },
] as const;

export type FontId = (typeof FONT_OPTIONS)[number]['id'];

export const FONTS = FONT_OPTIONS;

export function fontCss(id: string | undefined): string | undefined {
  const f = FONT_OPTIONS.find((x) => x.id === id);
  return f?.css;
}

/** Default font applied to a new line. */
export const DEFAULT_FONT: FontId = 'mono';

/** Built-in emoji shortcuts — the editor turns these into emoji. */
export const EMOJI_SHORTCUTS: Record<string, string> = {
  ':)': '🙂',
  ':D': '😄',
  ':(': '😞',
  ';)': '😉',
  ':p': '😛',
  '<3': '❤️',
  '</3': '💔',
  ':+1:': '👍',
  ':-1:': '👎',
  ':fire:': '🔥',
  ':star:': '⭐',
  ':100:': '💯',
  ':eyes:': '👀',
  ':rocket:': '🚀',
  ':sparkles:': '✨',
  ':wave:': '👋',
  ':ok:': '👌',
  ':clap:': '👏',
  ':tada:': '🎉',
  ':bug:': '🐛',
  ':warning:': '⚠️',
};

// ------------------------------------------------------------------
// Inline mark merge helper — used by the rich editor and by the
// "auto-detect links" path.
// ------------------------------------------------------------------

export function detectLinks(text: string): InlineMark[] {
  // Catch a wide variety: http(s)://, www., bare domains (.com/.org/.../),
  // mailto, tel. We deliberately allow anything that LOOKS like a URL.
  const re =
    /\b((?:https?:\/\/|www\.)[^\s<>"]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|tel:\+?[0-9()\-.\s]{4,20})/g;
  const out: InlineMark[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const value = m[0];
    let url = value;
    if (!/^https?:\/\//i.test(url) && !/^mailto:/i.test(url) && !/^tel:/i.test(url)) {
      if (value.includes('@')) url = 'mailto:' + value;
      else if (/^www\./i.test(value)) url = 'http://' + value;
      else url = 'http://' + value;
    }
    out.push({ start: m.index, end: m.index + value.length, kind: 'link', value: url });
  }
  return out;
}

/** Returns text that, when rendered, has visible replacement of sticker tokens. */
export function inlineCount(line: RichLine): { chars: number; tokens: number } {
  const tokens = (line.marks ?? []).filter((m) => m.kind !== 'link').length;
  return { chars: line.text.length, tokens };
}

// ------------------------------------------------------------------
// Sticker / emoji shortcode detection
// ------------------------------------------------------------------
// Tokens look like `:wave:` or `;happy;`. The rendered result replaces
// them with the sticker/GIF (or fallback emoji) instead of showing the
// raw shortcode.
// ------------------------------------------------------------------

// Must stay consistent with the admin route/server validation
// (^:[a-z0-9_+-]+:$) so hyphenated tokens like :anime-wave: convert too.
const STICKER_TOKEN_RE = /:([a-z0-9_+-]{1,32}):|;([a-z0-9_+-]{1,32});/gi;

export type TokenHit = { start: number; end: number; token: string };

/** Finds every sticker/emoji shortcode in a line of text. */
export function findTokenShorthands(text: string): TokenHit[] {
  const out: TokenHit[] = [];
  let m: RegExpExecArray | null;
  STICKER_TOKEN_RE.lastIndex = 0;
  while ((m = STICKER_TOKEN_RE.exec(text))) {
    const name = m[1] || m[2];
    out.push({ start: m.index, end: m.index + m[0].length, token: `:${name}:` });
  }
  return out;
}

/**
 * Rebuilds the inline marks for a line from scratch:
 * 1. sticker-pack tokens → 'sticker' marks (keep the token as text);
 * 2. remaining emoji shortcuts → 'emoji' marks;
 * 3. URL / email / phone detection → 'link' marks.
 * Runs on every edit so typed or pasted shorthands resolve immediately.
 */
export function buildInlineMarks(
  text: string,
  stickerTokens: ReadonlySet<string>,
  /** Additional valid sticker tokens for this line, e.g. keys of line.stickerUrls. */
  extraTokens: ReadonlySet<string> = EMPTY_SET,
): InlineMark[] {
  const marks: InlineMark[] = [];
  for (const hit of findTokenShorthands(text)) {
    if (stickerTokens.has(hit.token) || extraTokens.has(hit.token)) {
      marks.push({ start: hit.start, end: hit.end, kind: 'sticker', value: hit.token });
    } else if (EMOJI_SHORTCUTS[hit.token]) {
      marks.push({ start: hit.start, end: hit.end, kind: 'emoji', value: EMOJI_SHORTCUTS[hit.token] });
    }
  }
  marks.push(...detectLinks(text));
  return marks.sort((a, b) => a.start - b.start);
}

const EMPTY_SET: ReadonlySet<string> = new Set();

// ------------------------------------------------------------------
// Link-mark URL safety (server-side stored-XSS defense).
//
// The rich renderer puts a link mark's `value` straight into an <a href>.
// The editor only ever produces safe URLs, but the creation API must not
// trust a hand-crafted RichDoc: a link value that could become an
// executable (or otherwise dangerous) href must be rejected BEFORE the doc
// is stored. Validation lives here so every RichDoc write path shares one
// rule; stored legacy docs are left untouched and keep rendering as before.
// ------------------------------------------------------------------

/**
 * Schemes a stored link mark may use. `http:`/`https:` are the intended web
 * schemes; `mailto:`/`tel:` are the two non-executable schemes the editor
 * itself emits for emails/phone numbers (rejecting them would break
 * ordinary editor saves).
 */
const SAFE_LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);

/**
 * ASCII control characters + all whitespace. The WHATWG URL parser silently
 * strips tab/newline/CR (and leading/trailing C0/space), so these must be
 * rejected up front — `\tjavascript:alert(1)` would otherwise normalize to
 * `javascript:alert(1)` inside `new URL`.
 */
const UNSAFE_LINK_CHARS = /[\u0000-\u001f\u007f\s]/;

/** Must start with `<scheme>:` — rejects protocol-relative (`//…`), empty
 * and scheme-less values outright. Case-insensitive: the URL parse below
 * is the authoritative (lower-cased) check. */
const SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:/i;

/**
 * True when a link mark value is safe to store as an `<a href>`:
 * a well-formed absolute URL on an allowed, non-executable scheme.
 */
export function isSafeLinkValue(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0) return false;
  if (UNSAFE_LINK_CHARS.test(value)) return false;
  if (!SCHEME_PREFIX.test(value)) return false;
  // http(s) values must use the full `scheme://` form: the WHATWG parser
  // happily normalizes `http:/x` / `http:x` into a web URL, but such
  // half-formed values are malformed input and rejected outright.
  if (!/^https?:\/\//i.test(value)) {
    const scheme = value.slice(0, value.indexOf(':')).toLowerCase();
    if (scheme === 'http' || scheme === 'https') return false;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (!SAFE_LINK_SCHEMES.has(url.protocol)) return false;
  // http(s) needs a real host — `http://?x` parses but is malformed.
  if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname === '') {
    return false;
  }
  return true;
}

/**
 * True when every link mark in the doc carries a safe value. Non-link marks
 * (sticker, emoji) and per-line font/size/color are never inspected;
 * malformed mark shapes (non-arrays, non-object entries) are skipped
 * defensively — the renderer already ignores them.
 */
export function richDocLinksAreSafe(doc: RichDoc): boolean {
  return doc.lines.every((line) => {
    if (!Array.isArray(line.marks)) return true;
    return line.marks.every((m) => {
      if (!m || typeof m !== 'object') return true;
      const { kind, value } = m as Partial<InlineMark>;
      return kind !== 'link' || isSafeLinkValue(value);
    });
  });
}

/** Sorts and drops invalid/overlapping marks defensively (bad data safety). */
export function sanitizeMarks(marks: InlineMark[] | undefined, textLength: number): InlineMark[] {
  if (!marks || marks.length === 0) return [];
  const sorted = marks
    .filter(
      (m) =>
        Number.isInteger(m.start) &&
        Number.isInteger(m.end) &&
        m.start >= 0 &&
        m.end > m.start &&
        m.end <= textLength,
    )
    .sort((a, b) => a.start - b.start);
  const out: InlineMark[] = [];
  let cursor = 0;
  for (const m of sorted) {
    if (m.start < cursor) continue; // overlap → drop
    out.push(m);
    cursor = m.end;
  }
  return out;
}

export type { ReactNode };
