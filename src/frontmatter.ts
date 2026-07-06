/**
 * PORT of Calyx cli/src/lib/frontmatter.ts (keep in sync manually).
 *
 * Frontmatter parsing and serialization.
 *
 * Extracted from src/editor/frontmatterUtils.ts — zero VS Code deps.
 * This is the shared core that the CLI, MCP server, and extension should all use.
 */

import matter from "gray-matter";

export type ParsedResult = {
  properties: Record<string, unknown>;
  propertyTypes: Record<string, string>;
  content: string;
  rawFrontmatter?: string | null;
  error?: string;
};

const EMPTY_OBJECT: Record<string, never> = {};
const TYPE_HINT_KEY = "_nf_types";
const SCHEMA_OWNED_TYPE_KEYS = new Set(["type", "status", "priority", "executor"]);

export function normalizePropertyKey(key: string): string {
  return key.trim().toLowerCase();
}

export function toPlainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  try {
    // Normalize Date objects to YYYY-MM-DD strings before JSON round-trip.
    // gray-matter parses bare YAML dates (e.g. `due: 2026-03-15`) into JS Date
    // objects, and JSON.stringify turns those into ISO timestamps like
    // "2026-03-15T00:00:00.000Z". We want consistent YYYY-MM-DD strings.
    const normalized = normalizeDates(value as Record<string, unknown>);
    const cloned = JSON.parse(JSON.stringify(normalized));
    if (!cloned || typeof cloned !== "object" || Array.isArray(cloned)) return {};
    return cloned as Record<string, unknown>;
  } catch {
    return {};
  }
}

function normalizeDates(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value instanceof Date) {
      // Format as YYYY-MM-DD in local timezone (matches how users write dates)
      const y = value.getFullYear();
      const m = String(value.getMonth() + 1).padStart(2, "0");
      const d = String(value.getDate()).padStart(2, "0");
      result[key] = `${y}-${m}-${d}`;
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = normalizeDates(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function canonicalizeRecord<T>(
  record: Record<string, T>,
  options?: { excludeKeys?: Set<string> }
): Record<string, T> {
  return Object.entries(record).reduce<Record<string, T>>((acc, [key, value]) => {
    const normalizedKey = normalizePropertyKey(key);
    if (!normalizedKey) return acc;
    if (options?.excludeKeys?.has(normalizedKey)) return acc;
    acc[normalizedKey] = value;
    return acc;
  }, {});
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasMatchingPropertyKey(
  properties: Record<string, unknown>,
  normalizedKey: string
): boolean {
  return Object.keys(properties).some((key) => normalizePropertyKey(key) === normalizedKey);
}

export function sanitizePropertyTypes(
  propertyTypes: Record<string, unknown>,
  properties: Record<string, unknown>,
  options?: { requireMatchingProperty?: boolean }
): Record<string, string> {
  return Object.entries(propertyTypes).reduce<Record<string, string>>((acc, [key, value]) => {
    const normalizedKey = normalizePropertyKey(key);
    if (!normalizedKey || SCHEMA_OWNED_TYPE_KEYS.has(normalizedKey)) return acc;
    if (options?.requireMatchingProperty && !hasMatchingPropertyKey(properties, normalizedKey)) return acc;
    if (typeof value !== "string" || !value.trim()) return acc;
    acc[normalizedKey] = value.trim();
    return acc;
  }, {});
}

function coerceSemanticScalarValue(key: string, value: unknown): unknown {
  const normalizedKey = normalizePropertyKey(key);
  if (!SCHEMA_OWNED_TYPE_KEYS.has(normalizedKey) || !Array.isArray(value)) return value;
  const firstNonEmpty = value.find((item) => {
    if (item == null) return false;
    if (typeof item === "string") return item.trim().length > 0;
    return true;
  });
  if (firstNonEmpty == null) return "";
  return typeof firstNonEmpty === "string" ? firstNonEmpty : String(firstNonEmpty);
}

export function sanitizeProperties(properties: Record<string, unknown>): Record<string, unknown> {
  const canonicalized = canonicalizeRecord(properties, {
    excludeKeys: new Set([TYPE_HINT_KEY]),
  });
  return Object.entries(canonicalized).reduce<Record<string, unknown>>((acc, [key, value]) => {
    acc[key] = coerceSemanticScalarValue(key, value);
    return acc;
  }, {});
}

function coerceScalar(value: unknown, typeHint?: string): unknown {
  if (value == null) return value;
  if (typeHint === "boolean") return value === "false" ? false : Boolean(value);
  if (typeHint === "number") {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  return value;
}

export function parseFrontmatter(markdown: string): ParsedResult {
  const rawMatch = /^---\s*\n[\s\S]*?\n---\s*\n?/m.exec(markdown ?? "");
  const rawFrontmatter = rawMatch ? rawMatch[0] : null;
  try {
    const parsed = matter(markdown ?? "");
    const data = toPlainObject(parsed.data ?? EMPTY_OBJECT);
    const canonicalData = canonicalizeRecord(data);
    const properties = sanitizeProperties(canonicalData);
    const typeHints = sanitizePropertyTypes(
      toPlainObject(canonicalData[TYPE_HINT_KEY]),
      properties
    );
    Object.entries(properties).forEach(([key, val]) => {
      const hint = typeHints?.[key];
      properties[key] = coerceScalar(val, hint);
    });
    return { properties, propertyTypes: typeHints, content: parsed.content ?? "", rawFrontmatter };
  } catch (err: any) {
    return {
      properties: {},
      propertyTypes: {},
      content: markdown ?? "",
      rawFrontmatter,
      error: err?.message ?? "Failed to parse frontmatter.",
    };
  }
}

export function serializeFrontmatter(
  properties: Record<string, unknown>,
  content: string,
  propertyTypes?: Record<string, string>
): string {
  const plain = sanitizeProperties(toPlainObject(properties));
  const types = sanitizePropertyTypes(toPlainObject(propertyTypes ?? {}), plain, {
    requireMatchingProperty: true,
  });
  const hasProperties = Object.keys(plain).length > 0;
  const safeContent = typeof content === "string" ? content : String(content ?? "");
  if (!hasProperties && Object.keys(types).length === 0) return safeContent;
  const data = { ...plain };
  if (Object.keys(types).length > 0) data[TYPE_HINT_KEY] = types;
  return matter.stringify(safeContent, data);
}

export function updateFrontmatter(
  markdown: string,
  updates: Record<string, unknown>
): string {
  const parsed = parseFrontmatter(markdown);
  const deepMerge = (target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> => {
    const result = { ...target };
    for (const [key, value] of Object.entries(source)) {
      if (value === null) {
        // null means "delete this key"
        delete result[key];
      } else if (isPlainObject(value) && isPlainObject(target[key])) {
        result[key] = deepMerge(target[key] as Record<string, unknown>, value as Record<string, unknown>);
      } else {
        result[key] = value;
      }
    }
    return result;
  };
  const mergedProperties = deepMerge(sanitizeProperties(parsed.properties), sanitizeProperties(updates));
  return serializeFrontmatter(mergedProperties, parsed.content, parsed.propertyTypes);
}
