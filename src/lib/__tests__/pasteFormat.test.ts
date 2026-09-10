/**
 * Unified paste format tests.
 *
 * The unified editor always stores a RichDoc (format 'rich'); legacy
 * 'plain' rows and legacy 'rich' rows must keep parsing and rendering
 * exactly as before. These tests pin the shared read-side helpers that
 * make one flow out of the two old formats:
 *
 *  - parsePasteContent: legacy dispatch + malformed-row fallback
 *  - richDocToPlainText: raw/download + "Copy content" rendering
 *  - hasRichFormatting: the Rich badge (formatting, not format)
 *  - mark building: links/stickers/emoji shared by editor + viewer
 */
import { describe, expect, it } from 'vitest';

import {
  buildInlineMarks,
  detectLinks,
  hasRichFormatting,
  isRichDoc,
  richDocHasStickerMarks,
  parsePasteContent,
  richDocToPlainText,
  sanitizeMarks,
  type RichDoc,
  type RichLine,
} from '@/lib/pasteFormat';

function doc(lines: RichLine[]): RichDoc {
  return { v: 1, lines };
}

describe('parsePasteContent — backward compatibility', () => {
  it('returns legacy plain content byte-for-byte', () => {
    const stored = 'hello\nworld: https://example.com\n';
    expect(parsePasteContent('plain', stored)).toBe(stored);
  });

  it('legacy plain rows that look like JSON are still returned as strings', () => {
    const stored = '{"v":1,"lines":[{"text":"pretender"}]}';
    expect(parsePasteContent('plain', stored)).toBe(stored);
  });

  it('parses stored rich docs (old and unified alike)', () => {
    const d = doc([{ text: 'hi', font: 'mono', size: 14 }]);
    expect(parsePasteContent('rich', JSON.stringify(d))).toEqual(d);
  });

  it('falls back to the raw string when a rich row is not valid JSON or not a RichDoc', () => {
    expect(parsePasteContent('rich', 'not json at all')).toBe('not json at all');
    expect(parsePasteContent('rich', '{"v":2,"lines":[]}')).toBe('{"v":2,"lines":[]}');
  });
});

describe('isRichDoc', () => {
  it('accepts v1 docs and rejects everything else', () => {
    expect(isRichDoc(doc([{ text: '' }]))).toBe(true);
    expect(isRichDoc(doc([]))).toBe(true);
    expect(isRichDoc({ v: 2, lines: [] })).toBe(false);
    expect(isRichDoc({ lines: [{ text: 'x' }] })).toBe(false);
    expect(isRichDoc({ v: 1, lines: 'nope' })).toBe(false);
    expect(isRichDoc({ v: 1, lines: [{ text: 42 }] })).toBe(false);
    expect(isRichDoc(null)).toBe(false);
    expect(isRichDoc('hi')).toBe(false);
  });
});

describe('richDocToPlainText', () => {
  it('flattens a unified doc back to plain text, line by line', () => {
    const d = doc([
      { text: 'function hi() {' },
      { text: '  return "yo";' },
      { text: '}' },
    ]);
    expect(richDocToPlainText(d)).toBe('function hi() {\n  return "yo";\n}');
  });

  it('keeps sticker/emoji shortcode text (same as the legacy page helper)', () => {
    const d = doc([
      {
        text: 'hey :wave:!',
        marks: [
          { start: 4, end: 10, kind: 'sticker', value: ':wave:' },
          { start: 4, end: 10, kind: 'emoji', value: '👋' },
        ],
      },
    ]);
    expect(richDocToPlainText(d)).toBe('hey :wave:!');
  });

  it('tolerates missing text on a line', () => {
    expect(richDocToPlainText(doc([{ text: 'a' }, {} as RichLine]))).toBe('a\n');
  });
});

describe('hasRichFormatting', () => {
  it('a unified plain-text paste is NOT rich', () => {
    expect(hasRichFormatting(doc([{ text: 'just text' }, { text: '' }]))).toBe(false);
  });

  it('auto-detected links alone do not count as rich (plain viewer links too)', () => {
    const d = doc([
      {
        text: 'see https://example.com',
        marks: [{ start: 4, end: 23, kind: 'link', value: 'https://example.com' }],
      },
    ]);
    expect(hasRichFormatting(d)).toBe(false);
  });

  it('font/size/color or sticker/emoji marks make a doc rich', () => {
    expect(hasRichFormatting(doc([{ text: 'x', font: 'serif' }]))).toBe(true);
    expect(hasRichFormatting(doc([{ text: 'x', size: 32 }]))).toBe(true);
    expect(hasRichFormatting(doc([{ text: 'x', color: '#f00' }]))).toBe(true);
    expect(
      hasRichFormatting(
        doc([{ text: ':wave:', marks: [{ start: 0, end: 6, kind: 'sticker', value: ':wave:' }] }]),
      ),
    ).toBe(true);
  });

  it('handles the legacy string fallback without throwing', () => {
    expect(hasRichFormatting('raw string content')).toBe(false);
  });
});

describe('richDocHasStickerMarks — does the paste page need the sticker pack?', () => {
  it('plain-text docs, styled docs, emoji and link marks never need the pack', () => {
    expect(richDocHasStickerMarks(doc([{ text: 'just text' }, { text: '' }]))).toBe(false);
    expect(richDocHasStickerMarks(doc([{ text: 'x', font: 'serif', size: 32, color: '#f00' }]))).toBe(false);
    expect(
      richDocHasStickerMarks(
        doc([{ text: 'hi 🔥', marks: [{ start: 3, end: 5, kind: 'emoji', value: '🔥' }] }]),
      ),
    ).toBe(false);
    expect(
      richDocHasStickerMarks(
        doc([
          {
            text: 'see https://example.com',
            marks: [{ start: 4, end: 23, kind: 'link', value: 'https://example.com' }],
          },
        ]),
      ),
    ).toBe(false);
  });

  it('a single sticker mark anywhere in the doc requires the pack', () => {
    const d = doc([
      { text: 'first line' },
      { text: 'hello :wave:', marks: [{ start: 6, end: 12, kind: 'sticker', value: ':wave:' }] },
    ]);
    expect(richDocHasStickerMarks(d)).toBe(true);
  });

  it('stickers with an explicit per-line url still count (alt/label come from the pack)', () => {
    const d = doc([
      {
        text: ':anime-hug:',
        marks: [{ start: 0, end: 11, kind: 'sticker', value: ':anime-hug:' }],
        stickerUrls: { ':anime-hug:': 'https://example.com/hug.gif' },
      },
    ]);
    expect(richDocHasStickerMarks(d)).toBe(true);
  });

  it('ignores sticker marks the renderer itself would drop (out of range / overlapping)', () => {
    // Same sanitizeMarks pass the viewer applies: an out-of-range mark is
    // never rendered, so it must not trigger a pack read either.
    expect(
      richDocHasStickerMarks(
        doc([{ text: 'short', marks: [{ start: 0, end: 40, kind: 'sticker', value: ':wave:' }] }]),
      ),
    ).toBe(false);
  });

  it('handles the legacy string fallback and missing marks without throwing', () => {
    expect(richDocHasStickerMarks('raw string content')).toBe(false);
    expect(richDocHasStickerMarks(doc([{ text: 'x', marks: undefined }]))).toBe(false);
  });
});

describe('inline marks (shared by editor, preview and viewer)', () => {
  it('detectLinks covers http(s), www., email and tel and normalizes URLs', () => {
    const marks = detectLinks('a https://x.dev/p www.y.dev me@z.org tel:+1-555-0100');
    expect(marks.map((m) => m.value)).toEqual([
      'https://x.dev/p',
      'http://www.y.dev',
      'mailto:me@z.org',
      'tel:+1-555-0100',
    ]);
  });

  it('buildInlineMarks turns known pack tokens into stickers, other shorthands into emoji, and sorts marks', () => {
    const pack = new Set([':fire:']);
    const marks = buildInlineMarks(':fire: and :rocket: go https://a.dev', pack);
    expect(marks.map((m) => m.kind)).toEqual(['sticker', 'emoji', 'link']);
    expect(marks[0].value).toBe(':fire:');
    expect(marks[1].value).toBe('🚀'); // EMOJI_SHORTCUTS fallback
  });

  it('respects per-line explicit sticker urls (searched GIFs)', () => {
    const marks = buildInlineMarks('look :gif-abc123:', new Set(), new Set([':gif-abc123:']));
    expect(marks).toEqual([{ start: 5, end: 17, kind: 'sticker', value: ':gif-abc123:' }]);
  });

  it('sanitizeMarks drops out-of-range and overlapping marks defensively', () => {
    const cleaned = sanitizeMarks(
      [
        { start: 10, end: 12, kind: 'link', value: 'http://a.dev' },
        { start: 11, end: 14, kind: 'link', value: 'http://b.dev' }, // overlap → dropped
        { start: 5, end: 99, kind: 'sticker', value: ':x:' }, // out of range → dropped
      ],
      12,
    );
    expect(cleaned).toEqual([{ start: 10, end: 12, kind: 'link', value: 'http://a.dev' }]);
    expect(sanitizeMarks(undefined, 5)).toEqual([]);
  });
});
