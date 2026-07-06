/**
 * PORT of Calyx cli/src/lib/frontmatterSurgeon.ts (keep in sync manually).
 *
 * Surgical frontmatter writer — CLI port of src/editor/frontmatterSurgeon.ts.
 *
 * Same contract as `serializeFrontmatter(properties, content, propertyTypes)`,
 * plus the original markdown, so unchanged lines survive byte-for-byte:
 * comments, key casing, key order, quote styles, and any value we didn't touch
 * stay exactly as the author wrote them.
 *
 * Strategy: diff the sanitized target against the sanitized parse of the
 * original (same pipeline on both sides), then splice replacement text into
 * the original YAML block using source ranges from the `yaml` CST. Every
 * result is verified by re-parsing; any mismatch, parse error, or unsupported
 * shape falls back to the legacy full rewrite — the floor is the old
 * behavior, never a corrupted file.
 */
import { Document, Scalar, isCollection, isMap, isScalar, parseDocument, visit } from "yaml";
import type { Pair, YAMLMap } from "yaml";
import {
  normalizePropertyKey,
  parseFrontmatter,
  sanitizeProperties,
  sanitizePropertyTypes,
  serializeFrontmatter,
  toPlainObject,
} from "./frontmatter.ts";

const TYPE_HINT_KEY = "_nf_types";

export function serializeFrontmatterPreserving(
  originalMarkdown: string,
  properties: Record<string, unknown>,
  content: string,
  propertyTypes?: Record<string, string>
): string {
  const safeContent = typeof content === "string" ? content : String(content ?? "");
  const targetProps = sanitizeProperties(toPlainObject(properties));
  const targetTypes = sanitizePropertyTypes(toPlainObject(propertyTypes ?? {}), targetProps, {
    requireMatchingProperty: true,
  });

  if (Object.keys(targetProps).length === 0 && Object.keys(targetTypes).length === 0) {
    return safeContent;
  }

  const fallback = () => serializeFrontmatter(properties, safeContent, propertyTypes);

  try {
    const candidate = applySurgicalPatch(originalMarkdown, targetProps, targetTypes, safeContent);
    if (candidate === null) {
      return fallback();
    }
    if (!verifyCandidate(candidate, targetProps, targetTypes, safeContent)) {
      return fallback();
    }
    return candidate;
  } catch {
    return fallback();
  }
}

/**
 * Preserving sibling of `updateFrontmatter` (same deep-merge semantics:
 * null deletes a key), for callers that rewrite an existing file in place.
 */
export function updateFrontmatterPreserving(
  markdown: string,
  updates: Record<string, unknown>
): string {
  const parsed = parseFrontmatter(markdown);
  const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const deepMerge = (
    target: Record<string, unknown>,
    source: Record<string, unknown>
  ): Record<string, unknown> => {
    const result = { ...target };
    for (const [key, value] of Object.entries(source)) {
      if (value === null) {
        delete result[key];
      } else if (isPlainObject(value) && isPlainObject(target[key])) {
        result[key] = deepMerge(target[key] as Record<string, unknown>, value);
      } else {
        result[key] = value;
      }
    }
    return result;
  };
  const mergedProperties = deepMerge(
    sanitizeProperties(parsed.properties),
    sanitizeProperties(updates)
  );
  return serializeFrontmatterPreserving(
    markdown,
    mergedProperties,
    parsed.content,
    parsed.propertyTypes
  );
}

// ---------------------------------------------------------------------------
// Diff + splice
// ---------------------------------------------------------------------------

type Splice = { start: number; end: number; text: string };

function applySurgicalPatch(
  originalMarkdown: string,
  targetProps: Record<string, unknown>,
  targetTypes: Record<string, string>,
  content: string
): string | null {
  const parsedOriginal = parseFrontmatter(originalMarkdown);
  const rawBlock = parsedOriginal.rawFrontmatter;
  if (!rawBlock || parsedOriginal.error) {
    return null;
  }
  // The block extractor can match a horizontal rule mid-document; real
  // frontmatter starts at byte 0 (and our body reassembly assumes it does).
  if (!originalMarkdown.startsWith(rawBlock)) {
    return null;
  }

  // The closing-fence group tolerates trailing whitespace/newlines because the
  // upstream block extractor greedily includes the blank line after the fence.
  const blockParts = /^(---[^\n]*\n)([\s\S]*?)(\n---[^\n]*\n?\s*)$/.exec(rawBlock);
  if (!blockParts) {
    return null;
  }
  const [, fenceOpen, inner, fenceClose] = blockParts;

  const doc = parseDocument(inner, { keepSourceTokens: true });
  if (doc.errors.length > 0 || (doc.contents !== null && !isMap(doc.contents))) {
    return null;
  }

  const pairsByKey = new Map<string, Pair>();
  const rootPairs: Pair[] = doc.contents === null ? [] : (doc.contents as YAMLMap).items;
  for (const pair of rootPairs) {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
      return null;
    }
    const normalized = normalizePropertyKey(pair.key.value);
    if (!normalized || pairsByKey.has(normalized)) {
      return null;
    }
    pairsByKey.set(normalized, pair);
  }

  const originalProps = parsedOriginal.properties ?? {};
  const originalTypes = parsedOriginal.propertyTypes ?? {};

  const splices: Splice[] = [];
  const additions: string[] = [];

  for (const [key, value] of Object.entries(targetProps)) {
    const existing = pairsByKey.get(key);
    if (!existing) {
      additions.push(renderPair(key, value, { flow: false }));
      continue;
    }
    if (key in originalProps && canonical(originalProps[key]) === canonical(value)) {
      continue;
    }
    const splice = buildSetSplice(inner, existing, value);
    if (!splice) {
      return null;
    }
    splices.push(splice);
  }

  for (const key of Object.keys(originalProps)) {
    if (key in targetProps) {
      continue;
    }
    const existing = pairsByKey.get(key);
    if (!existing) {
      return null;
    }
    const splice = buildDeleteSplice(inner, existing);
    if (!splice) {
      return null;
    }
    splices.push(splice);
  }

  if (canonical(originalTypes) !== canonical(targetTypes)) {
    const existing = pairsByKey.get(TYPE_HINT_KEY);
    const isEmpty = Object.keys(targetTypes).length === 0;
    if (existing && isEmpty) {
      const splice = buildDeleteSplice(inner, existing);
      if (!splice) return null;
      splices.push(splice);
    } else if (existing) {
      const splice = buildSetSplice(inner, existing, targetTypes);
      if (!splice) return null;
      splices.push(splice);
    } else if (!isEmpty) {
      additions.push(renderPair(TYPE_HINT_KEY, targetTypes, { flow: false }));
    }
  }

  let nextInner = applySplices(inner, splices);
  for (const addition of additions) {
    nextInner = nextInner.length === 0 ? addition : `${nextInner}\n${addition}`;
  }

  const nextBlock = `${fenceOpen}${nextInner}${fenceClose}`;
  const bodyUnchanged = content === (parsedOriginal.content ?? "");
  return bodyUnchanged
    ? nextBlock + originalMarkdown.slice(rawBlock.length)
    : nextBlock + content;
}

function buildSetSplice(inner: string, pair: Pair, value: unknown): Splice | null {
  const key = pair.key as { value: string; range?: [number, number, number] };
  const valueNode = pair.value as {
    range?: [number, number, number];
    flow?: boolean;
    anchor?: string;
    tag?: string;
  } | null;
  if (!key.range || !valueNode || !valueNode.range) {
    return null;
  }
  if (valueNode.anchor || valueNode.tag) {
    return null;
  }
  const keepFlow = isCollection(pair.value) ? pair.value.flow === true : false;
  const text = renderPair(key.value, value, { flow: keepFlow });
  // Replace from key start to value end; anything after (inline comment) survives.
  // Block scalars own their trailing newline — never splice past a line break.
  const start = key.range[0];
  let end = valueNode.range[1];
  while (end > start && inner[end - 1] === "\n") {
    end--;
  }
  return { start, end, text };
}

function buildDeleteSplice(inner: string, pair: Pair): Splice | null {
  const key = pair.key as { range?: [number, number, number] };
  const valueNode = pair.value as { range?: [number, number, number] } | null;
  if (!key.range) {
    return null;
  }
  const end = valueNode?.range ? valueNode.range[2] : key.range[2];
  const lineStart = inner.lastIndexOf("\n", key.range[0] - 1) + 1;
  const newlineAt = inner.indexOf("\n", Math.max(end - 1, lineStart));
  const lineEnd = newlineAt === -1 ? inner.length : newlineAt + 1;
  // Deleting the last line (no trailing newline inside the block) must also
  // consume the newline that separated it from the previous line.
  const start = lineEnd === inner.length && lineStart > 0 ? lineStart - 1 : lineStart;
  return { start, end: lineEnd, text: "" };
}

function applySplices(source: string, splices: Splice[]): string {
  const ordered = [...splices].sort((a, b) => b.start - a.start);
  let result = source;
  let previousStart = Infinity;
  for (const splice of ordered) {
    if (splice.end > previousStart) {
      throw new Error("overlapping splices");
    }
    previousStart = splice.start;
    result = result.slice(0, splice.start) + splice.text + result.slice(splice.end);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Rendering + comparison
// ---------------------------------------------------------------------------

function renderPair(key: string, value: unknown, options: { flow: boolean }): string {
  const jsonSafe = JSON.parse(JSON.stringify({ v: value })).v;
  const doc = new Document({ [key]: jsonSafe });
  const valueNode = (doc.contents as YAMLMap).items[0]?.value;
  if (isCollection(valueNode)) {
    valueNode.flow = options.flow;
  }
  let text = doc.toString({ lineWidth: 0 }).trimEnd();
  // The reader (gray-matter/js-yaml, YAML 1.1) reinterprets some plain scalars
  // the 1.2 writer emits bare — dates, yes/no, etc. If the rendered pair does
  // not read back as the same data, force-quote the plain strings.
  if (!readsBackAs(text, key, jsonSafe)) {
    visit(doc, {
      Scalar(nodeKey, node) {
        if (nodeKey === "key") {
          return; // never quote the property name itself
        }
        if (typeof node.value === "string" && (!node.type || node.type === Scalar.PLAIN)) {
          node.type = Scalar.QUOTE_SINGLE;
        }
      },
    });
    text = doc.toString({ lineWidth: 0 }).trimEnd();
  }
  return text;
}

function readsBackAs(pairText: string, key: string, expected: unknown): boolean {
  const parsed = parseFrontmatter(`---\n${pairText}\n---\n`);
  if (parsed.error) {
    return false;
  }
  const normalized = normalizePropertyKey(key);
  const actual =
    normalized === TYPE_HINT_KEY ? parsed.propertyTypes : parsed.properties[normalized];
  return canonical(actual) === canonical(expected);
}

function canonical(value: unknown): string {
  return JSON.stringify(sortDeep(JSON.parse(JSON.stringify(value ?? null))));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortDeep);
  }
  if (value !== null && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortDeep((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

function verifyCandidate(
  candidate: string,
  targetProps: Record<string, unknown>,
  targetTypes: Record<string, string>,
  content: string
): boolean {
  const reparsed = parseFrontmatter(candidate);
  if (reparsed.error) {
    return false;
  }
  if (canonical(reparsed.properties) !== canonical(targetProps)) {
    return false;
  }
  if (canonical(reparsed.propertyTypes) !== canonical(targetTypes)) {
    return false;
  }
  return (reparsed.content ?? "") === content;
}
