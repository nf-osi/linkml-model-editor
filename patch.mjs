/**
 * Surgical, line-based YAML patching.
 *
 * The source modules are hand-formatted with varying style (single vs. double
 * quotes, indented vs. flush sequences). A full js-yaml re-dump would reformat
 * whole files and bury a one-line change in 90 lines of noise. These helpers
 * instead navigate by indentation and touch only the lines that actually change,
 * so `git diff` stays honest.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { ROOT } from './model.mjs';

const indentOf = (line) => line.match(/^(\s*)/)[0].length;
const isBlank = (line) => line.trim() === '';
const isComment = (line) => line.trim().startsWith('#');
const isListItem = (line) => line.trim().startsWith('- ') || line.trim() === '-';

/** Extract the (unquoted) key from a `key:` line, else null. */
function keyOf(line) {
  const t = line.trim();
  if (!t || t.startsWith('#') || t.startsWith('-')) return null;
  let m;
  if ((m = t.match(/^'((?:[^']|'')*)'\s*:(?:\s|$)/))) return m[1].replace(/''/g, "'");
  if ((m = t.match(/^"((?:[^"\\]|\\.)*)"\s*:(?:\s|$)/))) { try { return JSON.parse('"' + m[1] + '"'); } catch { return m[1]; } }
  if ((m = t.match(/^([^:]+?)\s*:(?:\s|$)/))) return m[1].trim();
  return null;
}

/** End (exclusive) of the block owned by the key at `keyIdx`. */
function blockEnd(lines, keyIdx) {
  const base = indentOf(lines[keyIdx]);
  let i = keyIdx + 1;
  for (; i < lines.length; i++) {
    if (isBlank(lines[i]) || isComment(lines[i])) continue;
    if (indentOf(lines[i]) <= base) break;
  }
  // back up over trailing blanks/comments so they belong to the next sibling
  let end = i;
  while (end > keyIdx + 1 && (isBlank(lines[end - 1]) || isComment(lines[end - 1]))) end--;
  return end;
}

/** Indentation shared by the direct children of the key at `keyIdx` (or null). */
function childIndent(lines, keyIdx) {
  const base = indentOf(lines[keyIdx]);
  const end = blockEnd(lines, keyIdx);
  for (let i = keyIdx + 1; i < end; i++) {
    if (isBlank(lines[i]) || isComment(lines[i])) continue;
    if (indentOf(lines[i]) > base) return indentOf(lines[i]);
  }
  return null;
}

/** Find a top-level key line index (indent 0). */
function findTopKey(lines, name) {
  for (let i = 0; i < lines.length; i++) {
    if (indentOf(lines[i]) === 0 && keyOf(lines[i]) === name) return i;
  }
  return -1;
}

/** Find a direct child key of the block at `parentIdx`. */
function findChild(lines, parentIdx, name) {
  const ci = childIndent(lines, parentIdx);
  if (ci == null) return -1;
  const end = blockEnd(lines, parentIdx);
  for (let i = parentIdx + 1; i < end; i++) {
    if (indentOf(lines[i]) === ci && keyOf(lines[i]) === name) return i;
  }
  return -1;
}

/** Resolve a path of keys (top-level first) to the deepest key's line index. */
function findPath(lines, segs) {
  let idx = findTopKey(lines, segs[0]);
  for (let s = 1; s < segs.length && idx >= 0; s++) idx = findChild(lines, idx, segs[s]);
  return idx;
}

// A plain scalar is safe unquoted unless it trips a YAML indicator. Keep the
// common cases (prose descriptions, CURIEs, URLs) bare to match repo style.
const YAML_RESERVED = /^(true|false|yes|no|on|off|null|~|-?\d+(\.\d+)?([eE][+-]?\d+)?)$/i;
function needsQuote(s) {
  if (s === '') return true;
  if (/[\n\t]/.test(s)) return true;
  if (s !== s.trim()) return true;                 // leading/trailing space
  if (/^[!&*?|>%@`"'#,\[\]{}]/.test(s)) return true; // starts with an indicator
  if (/^[-:?]\s/.test(s)) return true;             // "- ", ": ", "? "
  if (/:(\s|$)/.test(s)) return true;              // colon followed by space/end (key/value ambiguity)
  if (/\s#/.test(s)) return true;                  // space before comment marker
  if (YAML_RESERVED.test(s)) return true;          // would parse as bool/number/null
  return false;
}
function fmtScalar(value) {
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return String(value);
  const s = String(value);
  return needsQuote(s) ? "'" + s.replace(/'/g, "''") + "'" : s;
}

// Enum value keys commonly contain spaces, which is fine unquoted; only quote
// when an actual YAML indicator would break key parsing.
function quoteKey(k) {
  return needsQuote(k) ? "'" + k.replace(/'/g, "''") + "'" : k;
}

function load(rel) {
  const abs = resolve(ROOT, rel);
  return { abs, text: existsSync(abs) ? readFileSync(abs, 'utf-8') : null };
}
function save(abs, lines) {
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, lines.join('\n'));
}

/**
 * Set (or insert) a single scalar child field on the entity at `segs`.
 * Returns { changed, action }.
 */
export function setScalarField(rel, segs, field, value) {
  const { abs, text } = load(rel);
  if (text == null) throw new Error(`file not found: ${rel}`);
  const trailingNL = text.endsWith('\n');
  const lines = text.replace(/\n$/, '').split('\n');
  const parentIdx = findPath(lines, segs);
  if (parentIdx < 0) throw new Error(`path not found: ${segs.join(' > ')}`);
  const fieldIdx = findChild(lines, parentIdx, field);
  const newLine = (indent) => ' '.repeat(indent) + `${field}: ${fmtScalar(value)}`;

  let action;
  if (fieldIdx >= 0) {
    const indent = indentOf(lines[fieldIdx]);
    if (lines[fieldIdx] === newLine(indent)) return { changed: false, action: 'noop' };
    lines[fieldIdx] = newLine(indent);
    action = 'updated';
  } else {
    const ci = childIndent(lines, parentIdx);
    const indent = ci != null ? ci : indentOf(lines[parentIdx]) + 2;
    lines.splice(parentIdx + 1, 0, newLine(indent));
    action = 'inserted';
  }
  save(abs, trailingNL ? [...lines, ''] : lines);
  return { changed: true, action };
}

/** Render a permissible-value block as text lines at the given value indent. */
function renderValue(value, fields, valIndent) {
  const fIndent = valIndent + 2;
  const out = [' '.repeat(valIndent) + `${quoteKey(value)}:`];
  for (const [k, v] of Object.entries(fields)) {
    if (v == null || v === '') continue;
    if (Array.isArray(v)) {
      if (!v.length) continue;
      out.push(' '.repeat(fIndent) + `${k}:`);
      // flush block sequence (matches repo style: dash aligned with the key)
      for (const item of v) out.push(' '.repeat(fIndent) + `- ${fmtScalar(item)}`);
    } else {
      out.push(' '.repeat(fIndent) + `${k}: ${fmtScalar(v)}`);
    }
  }
  return out;
}

/**
 * Append permissible values to an existing enum. Skips values already present.
 * `values` = [{ value, description?, meaning?, source? }]. Returns { added: [...] }.
 */
export function addEnumValues(rel, enumName, values) {
  const { abs, text } = load(rel);
  if (text == null) throw new Error(`file not found: ${rel}`);
  const trailingNL = text.endsWith('\n');
  const lines = text.replace(/\n$/, '').split('\n');
  const pvIdx = findPath(lines, ['enums', enumName, 'permissible_values']);
  if (pvIdx < 0) throw new Error(`permissible_values not found for enum ${enumName}`);
  let valIndent = childIndent(lines, pvIdx);
  if (valIndent == null) valIndent = indentOf(lines[pvIdx]) + 2;

  const existing = new Set();
  const end = blockEnd(lines, pvIdx);
  for (let i = pvIdx + 1; i < end; i++) {
    if (indentOf(lines[i]) === valIndent) { const k = keyOf(lines[i]); if (k) existing.add(k); }
  }

  const added = [];
  const newLines = [];
  for (const v of values) {
    if (existing.has(v.value)) continue;
    newLines.push(...renderValue(v.value, { description: v.description, meaning: v.meaning, source: v.source, aliases: v.aliases }, valIndent));
    added.push(v.value);
  }
  if (!newLines.length) return { added: [] };
  lines.splice(end, 0, ...newLines);
  save(abs, trailingNL ? [...lines, ''] : lines);
  return { added };
}

/**
 * Create a new enum (appended to an existing `enums:` block, or a new file).
 * `values` = [{ value, description?, meaning?, source? }].
 */
export function createEnum(rel, enumName, { description = '', values = [] } = {}) {
  const { abs, text } = load(rel);
  const enumIndent = 2, fieldIndent = 4, valIndent = 6;
  const body = [];
  body.push(' '.repeat(enumIndent) + `${quoteKey(enumName)}:`);
  if (description) body.push(' '.repeat(fieldIndent) + `description: ${fmtScalar(description)}`);
  body.push(' '.repeat(fieldIndent) + `permissible_values:`);
  for (const v of values) {
    body.push(...renderValue(v.value, { description: v.description, meaning: v.meaning, source: v.source }, valIndent));
  }

  if (text == null) {
    save(abs, ['enums:', ...body, '']);
    return { created: true, file: rel };
  }
  const trailingNL = text.endsWith('\n');
  const lines = text.replace(/\n$/, '').split('\n');
  const enumsIdx = findTopKey(lines, 'enums');
  if (enumsIdx < 0) {
    // append a fresh enums: block
    const add = (lines.length && !isBlank(lines[lines.length - 1])) ? ['', 'enums:', ...body] : ['enums:', ...body];
    const out = [...lines, ...add];
    save(abs, trailingNL ? [...out, ''] : out);
  } else {
    if (findChild(lines, enumsIdx, enumName) >= 0) throw new Error(`enum ${enumName} already exists in ${rel}`);
    const end = blockEnd(lines, enumsIdx);
    lines.splice(end, 0, ...body);
    save(abs, trailingNL ? [...lines, ''] : lines);
  }
  return { created: true, file: rel };
}

/**
 * Create a new class (appended to an existing `classes:` block, or a new file).
 * def = { is_a, description, abstract, slots:[], annotations:{...} }
 */
export function createClass(rel, name, def = {}) {
  const ci = 2, fi = 4;
  const body = [' '.repeat(ci) + `${quoteKey(name)}:`];
  if (def.is_a) body.push(' '.repeat(fi) + `is_a: ${fmtScalar(def.is_a)}`);
  if (def.abstract) body.push(' '.repeat(fi) + `abstract: true`);
  if (def.description) body.push(' '.repeat(fi) + `description: ${fmtScalar(def.description)}`);
  const a = def.annotations || {};
  const aLines = [];
  for (const k of ['required', 'requiresComponent', 'templateUsage', 'dataGranularity']) {
    if (a[k] !== undefined && a[k] !== null && a[k] !== '') aLines.push(' '.repeat(fi + 2) + `${k}: ${fmtScalar(a[k])}`);
  }
  const tf = a.templateFor || {};
  const tfLines = [];
  for (const k of ['dataType', 'assay']) {
    if (Array.isArray(tf[k]) && tf[k].length) {
      tfLines.push(' '.repeat(fi + 4) + `${k}:`);
      for (const v of tf[k]) tfLines.push(' '.repeat(fi + 4) + `- ${fmtScalar(v)}`);
    }
  }
  if (aLines.length || tfLines.length) {
    body.push(' '.repeat(fi) + `annotations:`);
    body.push(...aLines);
    if (tfLines.length) { body.push(' '.repeat(fi + 2) + `templateFor:`); body.push(...tfLines); }
  }
  if (Array.isArray(def.slots) && def.slots.length) {
    body.push(' '.repeat(fi) + `slots:`);
    for (const s of def.slots) body.push(' '.repeat(fi) + `- ${fmtScalar(s)}`);
  }

  const { abs, text } = load(rel);
  if (text == null) { save(abs, ['classes:', ...body, '']); return { created: true, file: rel }; }
  const trailingNL = text.endsWith('\n');
  const lines = text.replace(/\n$/, '').split('\n');
  const idx = findTopKey(lines, 'classes');
  if (idx < 0) {
    const add = (lines.length && !isBlank(lines[lines.length - 1])) ? ['', 'classes:', ...body] : ['classes:', ...body];
    const out = [...lines, ...add];
    save(abs, trailingNL ? [...out, ''] : out);
  } else {
    if (findChild(lines, idx, name) >= 0) throw new Error(`class ${name} already exists in ${rel}`);
    const end = blockEnd(lines, idx);
    lines.splice(end, 0, ...body);
    save(abs, trailingNL ? [...lines, ''] : lines);
  }
  return { created: true, file: rel };
}

/** Append one entry to the manifest_schemas array in dca-template-config.json (minimal diff). */
export function addDcaEntry(displayName, schemaName, type = 'file', rel = 'dca-template-config.json') {
  const { abs, text } = load(rel);
  if (text == null) throw new Error('dca-template-config.json not found');
  const lines = text.split('\n');
  const startRe = /"manifest_schemas"\s*:\s*\[/;
  let start = lines.findIndex((l) => startRe.test(l));
  if (start < 0) throw new Error('manifest_schemas not found');
  // find the array close `]` after start
  let close = -1;
  for (let i = start + 1; i < lines.length; i++) { if (/^\s*\]/.test(lines[i])) { close = i; break; } }
  if (close < 0) throw new Error('could not find manifest_schemas close');
  if (lines.slice(start, close).some((l) => l.includes(`"schema_name": "${schemaName}"`))) return { added: false, file: rel };
  // ensure previous entry ends with a comma
  for (let i = close - 1; i > start; i--) { if (lines[i].trim()) { if (!lines[i].trimEnd().endsWith(',')) lines[i] = lines[i].replace(/\s*$/, ',') ; break; } }
  const entry = `      {"display_name": ${JSON.stringify(displayName)}, "schema_name": ${JSON.stringify(schemaName)}, "type": ${JSON.stringify(type)}}`;
  lines.splice(close, 0, entry);
  save(abs, lines);
  return { added: true, file: rel };
}

/** Append an item to a block sequence at `segs` (e.g. a class `slots:` list). */
export function addListItem(rel, segs, item) {
  const { abs, text } = load(rel);
  if (text == null) throw new Error(`file not found: ${rel}`);
  const trailingNL = text.endsWith('\n');
  const lines = text.replace(/\n$/, '').split('\n');
  let keyIdx = findPath(lines, segs);
  if (keyIdx < 0) {
    // the list key (e.g. aliases:, exact_mappings:) doesn't exist yet — create it
    // under its parent entity, then add the item below.
    const parent = segs.slice(0, -1);
    const pIdx = findPath(lines, parent);
    if (pIdx < 0) throw new Error(`path not found: ${segs.join(' > ')}`);
    const fieldIndent = childIndent(lines, pIdx);
    const at = blockEnd(lines, pIdx);
    lines.splice(at, 0, ' '.repeat(fieldIndent) + `${quoteKey(segs[segs.length - 1])}:`);
    keyIdx = at;
  }
  const end = blockEnd(lines, keyIdx);
  // detect existing list-item indent & whether item already present
  let itemIndent = null;
  for (let i = keyIdx + 1; i < end; i++) {
    if (isListItem(lines[i])) {
      itemIndent = indentOf(lines[i]);
      if (lines[i].trim().replace(/^-\s*/, '') === String(item)) return { changed: false };
    }
  }
  if (itemIndent == null) itemIndent = indentOf(lines[keyIdx]); // flush sequence (repo default)
  lines.splice(end, 0, ' '.repeat(itemIndent) + `- ${item}`);
  save(abs, trailingNL ? [...lines, ''] : lines);
  return { changed: true };
}

/** Remove one item from a YAML list at `segs`; drops the now-empty list key.
 *  Handles both nested (items indented under the key) and flush (items at the
 *  key's own indent — the repo's default) block sequences. */
export function removeListItem(rel, segs, item) {
  const { abs, text } = load(rel);
  if (text == null) throw new Error(`file not found: ${rel}`);
  const trailingNL = text.endsWith('\n');
  const lines = text.replace(/\n$/, '').split('\n');
  const keyIdx = findPath(lines, segs);
  if (keyIdx < 0) return { changed: false };
  const keyIndent = indentOf(lines[keyIdx]);
  // walk the key's item region: list items at indent >= keyIndent, or deeper nested lines
  const items = [];
  for (let i = keyIdx + 1; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.trim() === '') continue;
    const ind = indentOf(ln);
    if (isListItem(ln) && ind >= keyIndent) items.push(i);
    else if (ind > keyIndent) continue; // nested content of an item
    else break; // sibling key / dedent → end of this list
  }
  const target = items.find((i) => lines[i].trim().replace(/^-\s*/, '') === String(item));
  if (target == null) return { changed: false };
  lines.splice(target, 1);
  if (items.length === 1) lines.splice(keyIdx, 1); // was the only item → drop the empty key
  save(abs, trailingNL ? [...lines, ''] : lines);
  return { changed: true };
}

/** Create a dynamic enum bound to an ontology branch (LinkML reachable_from). */
export function createDynamicEnum(rel, enumName, { description = '', source_ontology, source_nodes = [], relationship_types = ['rdfs:subClassOf'], is_direct = false } = {}) {
  const { abs, text } = load(rel);
  const i2 = 2, i4 = 4, i6 = 6, i8 = 8;
  const body = [' '.repeat(i2) + `${quoteKey(enumName)}:`];
  if (description) body.push(' '.repeat(i4) + `description: ${fmtScalar(description)}`);
  body.push(' '.repeat(i4) + `reachable_from:`);
  if (source_ontology) body.push(' '.repeat(i6) + `source_ontology: ${fmtScalar(source_ontology)}`);
  body.push(' '.repeat(i6) + `source_nodes:`);
  for (const n of source_nodes) body.push(' '.repeat(i8) + `- ${n}`);
  body.push(' '.repeat(i6) + `relationship_types:`);
  for (const r of relationship_types) body.push(' '.repeat(i8) + `- ${r}`);
  body.push(' '.repeat(i6) + `is_direct: ${is_direct ? 'true' : 'false'}`);

  if (text == null) { save(abs, ['enums:', ...body, '']); return { created: true, file: rel }; }
  const trailingNL = text.endsWith('\n');
  const lines = text.replace(/\n$/, '').split('\n');
  const enumsIdx = findTopKey(lines, 'enums');
  if (enumsIdx < 0) {
    const add = (lines.length && lines[lines.length - 1].trim()) ? ['', 'enums:', ...body] : ['enums:', ...body];
    save(abs, trailingNL ? [...lines, ...add, ''] : [...lines, ...add]);
  } else {
    if (findChild(lines, enumsIdx, enumName) >= 0) throw new Error(`enum ${enumName} already exists in ${rel}`);
    lines.splice(blockEnd(lines, enumsIdx), 0, ...body);
    save(abs, trailingNL ? [...lines, ''] : lines);
  }
  return { created: true, file: rel };
}

/** Delete a permissible value (and its whole block) from an enum. */
export function removeEnumValue(rel, enumName, value) {
  const { abs, text } = load(rel);
  if (text == null) throw new Error(`file not found: ${rel}`);
  const trailingNL = text.endsWith('\n');
  const lines = text.replace(/\n$/, '').split('\n');
  const pvIdx = findPath(lines, ['enums', enumName, 'permissible_values']);
  if (pvIdx < 0) throw new Error(`permissible_values not found for enum ${enumName}`);
  const vIdx = findChild(lines, pvIdx, value);
  if (vIdx < 0) throw new Error(`value "${value}" not found in ${enumName}`);
  lines.splice(vIdx, blockEnd(lines, vIdx) - vIdx);
  save(abs, trailingNL ? [...lines, ''] : lines);
  return { removed: value };
}

/**
 * Edit a slot's contextual override inside a class's `slot_usage`.
 *   ranges:   array of range names — 1 => `range:`, >1 => `any_of:`; [] / undefined => leave range untouched
 *   required: true | false (set) | null (remove the override) | undefined (leave untouched)
 * Only the range/any_of/required lines are touched; other keys (e.g. ifabsent) are preserved.
 * Empties (slot entry / slot_usage block) are cleaned up.
 */
export function setSlotUsage(rel, className, slot, { ranges, required } = {}) {
  const { abs, text } = load(rel);
  if (text == null) throw new Error(`file not found: ${rel}`);
  const trailingNL = text.endsWith('\n');
  const lines = text.replace(/\n$/, '').split('\n');

  const classesIdx = findTopKey(lines, 'classes');
  if (classesIdx < 0) throw new Error(`no classes: block in ${rel}`);
  const classIdx = findChild(lines, classesIdx, className);
  if (classIdx < 0) throw new Error(`class ${className} not found in ${rel}`);
  const cfi = childIndent(lines, classIdx) ?? indentOf(lines[classIdx]) + 2;

  let suIdx = findChild(lines, classIdx, 'slot_usage');
  if (suIdx < 0) { const end = blockEnd(lines, classIdx); lines.splice(end, 0, ' '.repeat(cfi) + 'slot_usage:'); suIdx = end; }
  const si = childIndent(lines, suIdx) ?? indentOf(lines[suIdx]) + 2; // slot-entry indent
  const fi = si + 2;                                                  // field indent within an entry

  let slotIdx = findChild(lines, suIdx, slot);
  if (slotIdx < 0) { const end = blockEnd(lines, suIdx); lines.splice(end, 0, ' '.repeat(si) + `${quoteKey(slot)}:`); slotIdx = end; }

  if (ranges && ranges.length) {
    const rm = [];
    const rIdx = findChild(lines, slotIdx, 'range'); if (rIdx >= 0) rm.push([rIdx, rIdx + 1]);
    const aIdx = findChild(lines, slotIdx, 'any_of'); if (aIdx >= 0) rm.push([aIdx, blockEnd(lines, aIdx)]);
    rm.sort((a, b) => b[0] - a[0]).forEach(([s, e]) => lines.splice(s, e - s));
    slotIdx = findChild(lines, suIdx, slot);
    const ins = [];
    if (ranges.length > 1) { ins.push(' '.repeat(fi) + 'any_of:'); ranges.forEach((r) => ins.push(' '.repeat(fi + 2) + `- range: ${fmtScalar(r)}`)); }
    else ins.push(' '.repeat(fi) + `range: ${fmtScalar(ranges[0])}`);
    lines.splice(slotIdx + 1, 0, ...ins);
  }
  if (required !== undefined) {
    slotIdx = findChild(lines, suIdx, slot);
    const qIdx = findChild(lines, slotIdx, 'required');
    if (required === null) { if (qIdx >= 0) lines.splice(qIdx, 1); }
    else { const ln = ' '.repeat(fi) + `required: ${required === true || required === 'true'}`; if (qIdx >= 0) lines[qIdx] = ln; else lines.splice(slotIdx + 1, 0, ln); }
  }
  // prune emptied entry / block
  slotIdx = findChild(lines, suIdx, slot);
  if (slotIdx >= 0 && childIndent(lines, slotIdx) == null) lines.splice(slotIdx, 1);
  suIdx = findChild(lines, classIdx, 'slot_usage');
  if (suIdx >= 0 && childIndent(lines, suIdx) == null) lines.splice(suIdx, 1);

  save(abs, trailingNL ? [...lines, ''] : lines);
  return { ok: true };
}

// ---------------------------------------------------------------------------
//  Conditional `rules` (issue #5) — flush-style rendering + surgical add/edit/delete
//  of individual rule items so untouched rules never reformat.
// ---------------------------------------------------------------------------

/** Render one slot-condition object as flush YAML lines at `indent`. */
function renderCondition(cond, indent) {
  const out = [];
  for (const [k, v] of Object.entries(cond || {})) {
    if (v == null || v === '') continue;
    if (Array.isArray(v)) {                       // none_of / any_of: list of small objects
      if (!v.length) continue;
      out.push(' '.repeat(indent) + `${k}:`);
      for (const item of v) {
        const entries = Object.entries(item || {}).filter(([, x]) => x != null && x !== '');
        if (!entries.length) continue;
        const [fk, fv] = entries[0];
        out.push(' '.repeat(indent) + `- ${fk}: ${fmtScalar(fv)}`);
        for (const [ek, ev] of entries.slice(1)) out.push(' '.repeat(indent + 2) + `${ek}: ${fmtScalar(ev)}`);
      }
    } else {
      out.push(' '.repeat(indent) + `${k}: ${fmtScalar(v)}`);
    }
  }
  return out;
}

/** Render one rule as flush YAML lines; `dashIndent` is where the `- ` sits. */
function renderRule(rule, dashIndent) {
  const ci = dashIndent + 2;                       // continuation-key indent within the item
  const out = [' '.repeat(dashIndent) + `- description: ${fmtScalar(rule.description || '')}`];
  for (const side of ['preconditions', 'postconditions']) {
    const sc = rule[side] && rule[side].slot_conditions;
    if (!sc || !Object.keys(sc).length) continue;
    out.push(' '.repeat(ci) + `${side}:`);
    out.push(' '.repeat(ci + 2) + `slot_conditions:`);
    for (const [slot, cond] of Object.entries(sc)) {
      out.push(' '.repeat(ci + 4) + `${quoteKey(slot)}:`);
      out.push(...renderCondition(cond, ci + 6));
    }
  }
  return out;
}

/** Resolve a class's `rules:` key line (rulesIdx = -1 if absent). */
function locateRules(lines, className) {
  const classesIdx = findTopKey(lines, 'classes');
  if (classesIdx < 0) throw new Error(`no classes: block`);
  const classIdx = findChild(lines, classesIdx, className);
  if (classIdx < 0) throw new Error(`class ${className} not found`);
  return { classIdx, rulesIdx: findChild(lines, classIdx, 'rules') };
}

/** Line-spans (start incl., end excl.) of each rule item under a `rules:` key.
 *  Handles the repo's flush block sequences (dash at the key's own indent). */
function ruleItemSpans(lines, rulesIdx) {
  const keyIndent = indentOf(lines[rulesIdx]);
  let itemIndent = null;
  const starts = [];
  let end = lines.length;
  for (let i = rulesIdx + 1; i < lines.length; i++) {
    const ln = lines[i];
    if (isBlank(ln) || isComment(ln)) continue;
    const ind = indentOf(ln);
    if (itemIndent == null) {
      if (isListItem(ln) && ind >= keyIndent) itemIndent = ind;
      else { end = i; break; }                     // empty rules block
    }
    if (ind < itemIndent) { end = i; break; }       // dedent out of the block
    if (ind === itemIndent && !isListItem(ln)) { end = i; break; } // sibling key (annotations, slot_usage…)
    if (ind === itemIndent && isListItem(ln)) starts.push(i);
    // ind > itemIndent → continuation of the current item
  }
  const spans = starts.map((s, k) => {
    let e = k + 1 < starts.length ? starts[k + 1] : end;
    while (e > s + 1 && (isBlank(lines[e - 1]) || isComment(lines[e - 1]))) e--;
    return { start: s, end: e };
  });
  return { itemIndent: itemIndent == null ? keyIndent : itemIndent, spans, blockEnd: end };
}

/** Append a rule to a class's `rules:` block (creating the block if needed). */
export function addClassRule(rel, className, rule) {
  const { abs, text } = load(rel);
  if (text == null) throw new Error(`file not found: ${rel}`);
  const trailingNL = text.endsWith('\n');
  const lines = text.replace(/\n$/, '').split('\n');
  const { classIdx, rulesIdx } = locateRules(lines, className);
  if (rulesIdx < 0) {
    const cfi = childIndent(lines, classIdx) ?? indentOf(lines[classIdx]) + 2;
    const at = blockEnd(lines, classIdx);
    lines.splice(at, 0, ' '.repeat(cfi) + 'rules:', ...renderRule(rule, cfi));
    save(abs, trailingNL ? [...lines, ''] : lines);
    return { changed: true, action: 'created' };
  }
  const { itemIndent, blockEnd: bEnd } = ruleItemSpans(lines, rulesIdx);
  lines.splice(bEnd, 0, ...renderRule(rule, itemIndent));
  save(abs, trailingNL ? [...lines, ''] : lines);
  return { changed: true, action: 'appended' };
}

/** Replace the rule at `index` (0-based) in a class's `rules:` block. */
export function updateClassRule(rel, className, index, rule) {
  const { abs, text } = load(rel);
  if (text == null) throw new Error(`file not found: ${rel}`);
  const trailingNL = text.endsWith('\n');
  const lines = text.replace(/\n$/, '').split('\n');
  const { rulesIdx } = locateRules(lines, className);
  if (rulesIdx < 0) throw new Error(`class ${className} has no rules`);
  const { itemIndent, spans } = ruleItemSpans(lines, rulesIdx);
  if (index < 0 || index >= spans.length) throw new Error(`rule index ${index} out of range`);
  const { start, end } = spans[index];
  lines.splice(start, end - start, ...renderRule(rule, itemIndent));
  save(abs, trailingNL ? [...lines, ''] : lines);
  return { changed: true };
}

/** Delete the rule at `index`; drops the `rules:` key if it becomes empty. */
export function removeClassRule(rel, className, index) {
  const { abs, text } = load(rel);
  if (text == null) throw new Error(`file not found: ${rel}`);
  const trailingNL = text.endsWith('\n');
  const lines = text.replace(/\n$/, '').split('\n');
  const { classIdx, rulesIdx } = locateRules(lines, className);
  if (rulesIdx < 0) throw new Error(`class ${className} has no rules`);
  const { spans } = ruleItemSpans(lines, rulesIdx);
  if (index < 0 || index >= spans.length) throw new Error(`rule index ${index} out of range`);
  const { start, end } = spans[index];
  lines.splice(start, end - start);
  if (spans.length === 1) {                         // was the only rule → drop the empty key
    const rIdx = findChild(lines, classIdx, 'rules');
    if (rIdx >= 0 && childIndent(lines, rIdx) == null) lines.splice(rIdx, 1);
  }
  save(abs, trailingNL ? [...lines, ''] : lines);
  return { changed: true };
}

export { keyOf, findPath, findChild, blockEnd, childIndent };
