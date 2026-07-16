#!/usr/bin/env node
/**
 * Local-only server for the NF metadata model editor.
 *
 *   cd editor && npm install && npm start
 *   open http://localhost:5174
 *
 * Reads/writes the LinkML source under ../modules. All edits land in the
 * working tree only — review them with `git diff` before committing.
 */
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { dirname, resolve, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, watch, mkdirSync, copyFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { exec, execFile } from 'child_process';
import { CONFIG } from './config.mjs';
import { loadModel, buildGraph, modelSummary, readSourceFile, classifyRange, slotRanges, ROOT } from './model.mjs';
import { setScalarField, addEnumValues, createEnum, createClass, addDcaEntry, addListItem, removeListItem, createDynamicEnum, setSlotUsage, removeEnumValue } from './patch.mjs';
import { searchOntology, getDescendants, getTerm, getParents, domainHint } from './ontology.mjs';
import { toLinkMLYaml, toLinkMLFiles, slugify } from './linkml-export.mjs';

const KINDS = { classes: 'classes', slots: 'slots', enums: 'enums' };

// Reject client-supplied paths that could escape the model ROOT: empty, parent
// traversal (`..`), or absolute paths (which `resolve(ROOT, p)` would honor verbatim).
const unsafeRel = (p) => !p || p.includes('..') || isAbsolute(p);
function fileFor(kind, name) {
  const rel = loadModel().fileIndex[`${kind}:${name}`];
  if (!rel) throw new Error(`${kind}:${name} not found in model`);
  return rel;
}

// Resolve where a slot edit should be written. Inline `attributes:` live under
// `classes.<owner>.attributes.<name>`, not a top-level `slots:` block, so route there.
function slotTarget(name) {
  const model = loadModel();
  if (model.inlineOnly?.has(name)) {
    const owners = model.attrOwner[name] || [];
    if (owners.length > 1) throw new Error(`"${name}" is an inline attribute shared by ${owners.length} classes (${owners.join(', ')}); edit it in the source or terminal.`);
    if (owners.length === 1) return { rel: model.fileIndex[`classes:${owners[0]}`], path: ['classes', owners[0], 'attributes', name], attribute: true };
  }
  return { rel: model.fileIndex[`slots:${name}`], path: ['slots', name] };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 5174;
app.use(express.json({ limit: '8mb' }));

// Track our own mutating API calls so the file watcher can ignore GUI-originated
// writes (those are already reflected client-side) and only auto-reflect EXTERNAL
// edits (terminal / Claude Code / IDE).
let lastApiWrite = 0;
app.use((req, res, next) => { if (req.method !== 'GET' && req.path.startsWith('/api/')) lastApiWrite = Date.now(); next(); });

// Read-only models (e.g. schematic-csv): block every mutating API. The app is still
// fully usable for viewing the graph and ontology-gap analysis; write-back isn't wired.
const READONLY_SAFE = [/\/present$/]; // read-only computations that happen to use POST
app.use('/api', (req, res, next) => {
  if (CONFIG.readOnly && req.method !== 'GET' && !READONLY_SAFE.some((re) => re.test(req.path))) {
    return res.status(409).json({ error: `This model is read-only in the editor (format: "${CONFIG.format}"). Editing isn't wired for ${CONFIG.format} models yet — use the app to explore the model and find ontology gaps.` });
  }
  next();
});

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) { console.error(e); if (!res.headersSent) res.status(500).json({ error: e.message }); }
};

// ---- Model ----
app.get('/api/summary', wrap((req, res) => res.json(modelSummary(loadModel()))));

app.get('/api/graph', wrap((req, res) => {
  const model = loadModel();
  res.json({ ...buildGraph(model), summary: modelSummary(model) });
}));

app.get('/api/entity/:kind/:name', wrap((req, res) => {
  const { kind, name } = req.params;
  const model = loadModel();
  const map = { classes: model.classes, slots: model.slots, enums: model.enums }[kind];
  if (!map) return res.status(400).json({ error: `bad kind ${kind}` });
  if (!map[name]) return res.status(404).json({ error: `${kind}:${name} not found` });
  res.json({ kind, name, def: map[name], file: model.fileIndex[`${kind}:${name}`] || null });
}));

// Coerce edit values to the right YAML type: booleans, numbers (min/max), and
// empty→SKIP (no-op) for numerics. Everything else stays a string.
const SKIP = Symbol('skip');
const BOOL_FIELDS = new Set(['required', 'identifier', 'key', 'abstract', 'multivalued', 'recommended']);
const NUM_FIELDS = new Set(['minimum_value', 'maximum_value']);
function coerceField(field, value) {
  if (BOOL_FIELDS.has(field)) return value === true || value === 'true';
  if (NUM_FIELDS.has(field)) {
    if (value === '' || value == null) return SKIP;
    const n = Number(value);
    if (Number.isNaN(n)) throw new Error(`${field} must be a number`);
    return n;
  }
  return value;
}

// Set a single scalar field on a slot or class (range, required, description, title, is_a, abstract).
app.patch('/api/:kind(classes|slots)/:name', wrap((req, res) => {
  const { kind, name } = req.params;
  const { field, value } = req.body || {};
  if (!field) return res.status(400).json({ error: 'missing field' });
  const v = coerceField(field, value);
  if (v === SKIP) return res.json({ ok: true, noop: true });
  const t = kind === 'slots' ? slotTarget(name) : { rel: fileFor(kind, name), path: [kind, name] };
  res.json({ ok: true, file: t.rel, attribute: !!t.attribute, ...setScalarField(t.rel, t.path, field, v) });
}));

// Edit a slot's contextual override (range / any_of / required) within a template.
app.post('/api/classes/:name/slot-usage', wrap((req, res) => {
  const { name } = req.params;
  const { slot, ranges, required } = req.body || {};
  if (!slot) return res.status(400).json({ error: 'missing slot' });
  const rel = fileFor('classes', name);
  setSlotUsage(rel, name, slot, { ranges: Array.isArray(ranges) ? ranges : undefined, required });
  res.json({ ok: true, file: rel });
}));

// Append a slot reference to a class's `slots:` list.
app.post('/api/classes/:name/slot', wrap((req, res) => {
  const { name } = req.params;
  const { slot } = req.body || {};
  if (!slot) return res.status(400).json({ error: 'missing slot' });
  const rel = fileFor('classes', name);
  res.json({ ok: true, file: rel, ...addListItem(rel, ['classes', name, 'slots'], slot) });
}));

// Add/remove an item on a list field (aliases, exact_mappings, close_mappings, …)
// of a class/slot/enum. Routes inline-attribute slots to their class.
app.post('/api/list', wrap((req, res) => {
  const { kind, name, field, item, op } = req.body || {};
  if (!kind || !name || !field || !item) return res.status(400).json({ error: 'need kind, name, field, item' });
  const t = kind === 'slots' ? slotTarget(name) : { rel: fileFor(kind, name), path: [kind, name] };
  const segs = [...t.path, field];
  const r = op === 'remove' ? removeListItem(t.rel, segs, item) : addListItem(t.rel, segs, item);
  res.json({ ok: true, file: t.rel, ...r });
}));

// Create a dynamic enum bound to an ontology branch (LinkML reachable_from).
app.post('/api/enums/dynamic', wrap((req, res) => {
  const { name, file, description, source_ontology, source_nodes, relationship_types, is_direct } = req.body || {};
  if (!name || !file) return res.status(400).json({ error: 'need name and file' });
  res.json({ ok: true, ...createDynamicEnum(file, name, { description, source_ontology, source_nodes, relationship_types, is_direct }) });
}));

// Set/insert a field (meaning, source, description) on one enum permissible value.
app.patch('/api/enums/:name/value/:value', wrap((req, res) => {
  const { name, value } = req.params;
  const { field, val } = req.body || {};
  if (!field) return res.status(400).json({ error: 'missing field' });
  const rel = fileFor('enums', name);
  const result = setScalarField(rel, ['enums', name, 'permissible_values', value], field, val);
  res.json({ ok: true, file: rel, ...result });
}));

// Remove a permissible value from an enum.
app.delete('/api/enums/:name/value/:value', wrap((req, res) => {
  const rel = fileFor('enums', req.params.name);
  res.json({ ok: true, file: rel, ...removeEnumValue(rel, req.params.name, req.params.value) });
}));

// Append permissible values to an existing enum (bulk import / manual add).
app.post('/api/enums/:name/values', wrap((req, res) => {
  const { name } = req.params;
  const { values } = req.body || {};
  if (!Array.isArray(values) || !values.length) return res.status(400).json({ error: 'missing values[]' });
  const rel = fileFor('enums', name);
  res.json({ ok: true, file: rel, ...addEnumValues(rel, name, values) });
}));

// App config (title + which repo-specific features are enabled).
app.get('/api/config', (req, res) => res.json({
  title: CONFIG.title, subtitle: CONFIG.subtitle, templateDir: CONFIG.templateDir,
  format: CONFIG.format, readOnly: !!CONFIG.readOnly, convertedFrom: CONFIG.convertedFrom || null,
  features: { dca: !!CONFIG.dcaConfig, dataType: !!(CONFIG.dataTypeEnums && CONFIG.dataTypeEnums.length) },
}));

// Export the current model as a LinkML schema (migration artifact). GET, so it's
// allowed even for read-only schematic models — this is the "output LinkML so the
// team can migrate" path. Streams a downloadable .yaml.
app.get('/api/export/linkml', wrap((req, res) => {
  const model = loadModel();
  const yamlText = toLinkMLYaml(model, CONFIG.title);
  const fname = `${slugify(CONFIG.title)}.linkml.yaml`;
  if (req.query.download) {
    res.setHeader('Content-Type', 'application/x-yaml');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    return res.send(yamlText);
  }
  res.json({ filename: fname, yaml: yamlText, summary: modelSummary(model) });
}));

// Valid dataType annotation values (union of the configured dataType enums).
app.get('/api/datatypes', wrap((req, res) => {
  const m = loadModel();
  const vals = new Set();
  for (const name of CONFIG.dataTypeEnums || []) {
    Object.keys(m.enums[name]?.permissible_values || {}).forEach((k) => vals.add(k));
  }
  res.json({ values: [...vals].sort() });
}));

// Create a new class / template.
app.post('/api/classes', wrap((req, res) => {
  const { name, file, def = {}, dca } = req.body || {};
  if (!name || !file) return res.status(400).json({ error: 'need name and file' });
  if (unsafeRel(file)) return res.status(400).json({ error: 'bad file' });
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) return res.status(400).json({ error: 'class name must be alphanumeric (PascalCase), no spaces' });
  if (loadModel().classes[name]) return res.status(409).json({ error: `class ${name} already exists` });
  const result = createClass(file, name, def);
  let dcaResult = null;
  if (dca && dca.display_name && CONFIG.dcaConfig) dcaResult = addDcaEntry(dca.display_name, name, dca.type || 'file', CONFIG.dcaConfig);
  res.json({ ok: true, ...result, dca: dcaResult });
}));

// Create a new enum (wholesale ontology import or manual). Caller chooses the file.
app.post('/api/enums', wrap((req, res) => {
  const { name, file, description = '', values = [] } = req.body || {};
  if (!name || !file) return res.status(400).json({ error: 'need name and file' });
  if (unsafeRel(file)) return res.status(400).json({ error: 'bad file' });
  if (loadModel().enums[name]) return res.status(409).json({ error: `enum ${name} already exists` });
  res.json({ ok: true, ...createEnum(file, name, { description, values }) });
}));

app.get('/api/file', wrap((req, res) => {
  const rel = req.query.path;
  if (unsafeRel(rel)) return res.status(400).json({ error: 'bad path' });
  res.json({ path: rel, content: readSourceFile(rel) });
}));

// Enum values that lack an ontology `meaning` mapping — the gaps to fill.
app.get('/api/gaps', wrap((req, res) => {
  const model = loadModel();
  const wanted = req.query.enum;
  const gaps = [];
  for (const [name, def] of Object.entries(model.enums)) {
    if (wanted && name !== wanted) continue;
    const pv = def.permissible_values || {};
    const total = Object.keys(pv).length;
    // Counts only — the full unmapped list can be ~100k for some enums and is
    // lazy-loaded via GET /api/enums/:name/values when a gap detail is opened.
    const missingCount = Object.values(pv).filter((v) => !(v && v.meaning)).length;
    if (missingCount) {
      gaps.push({ enum: name, file: model.fileIndex[`enums:${name}`] || null,
        total, missingCount, mappedCount: total - missingCount });
    }
  }
  gaps.sort((a, b) => b.missingCount - a.missingCount);
  res.json({ gaps });
}));

// Paginated + filtered per-enum values (kept out of /api/graph and /api/gaps). Some
// enums have 100k+ values, so the client fetches a page at a time instead of all of
// them. Query: q (substring on value/meaning), unmapped=1, offset, limit.
app.get('/api/enums/:name/values', wrap((req, res) => {
  const model = loadModel();
  const def = model.enums[req.params.name];
  if (!def) return res.status(404).json({ error: `enum ${req.params.name} not found` });
  const pv = def.permissible_values || {};
  const q = String(req.query.q || '').trim().toLowerCase();
  const unmapped = req.query.unmapped === '1' || req.query.unmapped === 'true';
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 200));
  let total = 0, mappedCount = 0, matched = 0;
  const page = [];
  for (const [value, v] of Object.entries(pv)) {
    total++;
    const meaning = v?.meaning || null;
    if (meaning) mappedCount++;
    if (unmapped && meaning) continue;
    if (q && !(value.toLowerCase().includes(q) || String(meaning || '').toLowerCase().includes(q) || String(v?.description || '').toLowerCase().includes(q))) continue;
    if (matched >= offset && page.length < limit) {
      page.push({ value, meaning, source: v?.source || null, description: v?.description || '', deprecated: v?.deprecated || '' });
    }
    matched++;
  }
  res.json({ values: page, total, matched, mappedCount, offset, limit });
}));

const normLabel = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Membership check for the gap diff: given the ontology branch terms, return which
// are ALREADY present in the enum (by meaning CURIE or normalized label/synonym).
// Done server-side so the client never has to load a 100k-value enum to compare.
app.post('/api/enums/:name/present', wrap((req, res) => {
  const model = loadModel();
  const def = model.enums[req.params.name];
  if (!def) return res.status(404).json({ error: `enum ${req.params.name} not found` });
  const curies = new Set(), labels = new Set();
  for (const [value, v] of Object.entries(def.permissible_values || {})) {
    labels.add(normLabel(value));
    if (v?.meaning) curies.add(String(v.meaning).toLowerCase());
  }
  const terms = Array.isArray(req.body?.terms) ? req.body.terms : [];
  const present = [];
  for (const t of terms) {
    const hit = (t.curie && curies.has(String(t.curie).toLowerCase()))
      || labels.has(normLabel(t.label))
      || (Array.isArray(t.synonyms) && t.synonyms.some((s) => labels.has(normLabel(s))));
    if (hit) present.push(t.key ?? t.curie ?? t.label);
  }
  res.json({ present });
}));

// ---- Model QC / linter (fast, model-aware; complements `linkml-lint`) ----
const OPTIONAL_DATATYPE = new Set(['AnimalIndividualTemplate', 'PortalDataset', 'PortalStudy', 'PortalPublication', 'PublicationTemplate', 'DataLandscape', 'ProtocolTemplate', 'AnalysisResultTemplate']);
const isUrl = (s) => /^https?:\/\//i.test(String(s || ''));

function runQc(model) {
  const F = [];
  const add = (severity, kind, message, opts = {}) => F.push({ severity, kind, message, ...opts });
  const validDataTypes = new Set();
  for (const n of CONFIG.dataTypeEnums || []) Object.keys(model.enums[n]?.permissible_values || {}).forEach((k) => validDataTypes.add(k));

  // --- enums / permissible values ---
  const undeclaredPrefix = {}; // prefix -> count
  let urlMeaning = 0; const urlEx = [];
  let noDesc = 0;
  for (const [name, def] of Object.entries(model.enums)) {
    const pv = def.permissible_values || {};
    if (!Object.keys(pv).length) add('warn', 'empty-enum', `Enum "${name}" has no permissible values.`, { entity: name, file: model.fileIndex[`enums:${name}`] });
    for (const [val, v] of Object.entries(pv)) {
      const meaning = v && v.meaning;
      if (meaning) {
        if (isUrl(meaning)) { urlMeaning++; if (urlEx.length < 5) urlEx.push(`${name}.${val}`); }
        else if (meaning.includes(':')) { const p = meaning.split(':')[0]; if (!model.prefixes[p]) undeclaredPrefix[p] = (undeclaredPrefix[p] || 0) + 1; }
      }
      if (!(v && v.description)) noDesc++;
    }
  }
  for (const [p, n] of Object.entries(undeclaredPrefix)) add('error', 'undeclared-prefix', `CURIE prefix "${p}:" is used by ${n} value(s) but not declared in ${CONFIG.headerFile} prefixes.`, { entity: p, file: CONFIG.headerFile });
  if (urlMeaning) add('warn', 'url-meaning', `${urlMeaning} value(s) use a full URL in meaning: instead of a CURIE (e.g. ${urlEx.join(', ')}). Prefer a CURIE; put URLs in source:.`);
  if (noDesc) add('info', 'no-description', `${noDesc} permissible value(s) have no description.`);

  // --- slots: range targets resolve? ---
  const unknownRanges = {};
  for (const [name, def] of Object.entries(model.slots)) {
    for (const r of slotRanges(def)) if (classifyRange(r, model) === 'unknown') unknownRanges[r] = (unknownRanges[r] || []).concat(name);
  }
  for (const [r, slots] of Object.entries(unknownRanges)) add('warn', 'unknown-range', `Range "${r}" (used by ${slots.length} slot(s), e.g. ${slots.slice(0, 3).join(', ')}) is not a known enum, class, or type.`, { entity: r });

  // --- classes ---
  for (const [name, def] of Object.entries(model.classes)) {
    const file = model.fileIndex[`classes:${name}`] || '';
    for (const s of def.slots || []) if (!model.slots[s]) add('error', 'missing-slot', `Class "${name}" lists slot "${s}" which is not defined.`, { entity: name, file });
    for (const [s, ov] of Object.entries(def.slot_usage || {})) {
      for (const r of slotRanges(ov)) if (classifyRange(r, model) === 'unknown') add('warn', 'usage-range', `Class "${name}" slot_usage "${s}" range "${r}" is not a known enum/class/type.`, { entity: name, file });
    }
    if (def.is_a && !model.classes[def.is_a]) add('error', 'missing-parent', `Class "${name}" is_a "${def.is_a}" which is not defined.`, { entity: name, file });
    // template dataType requirement (mirrors tests/test_template_datatypes.py) — only when configured
    if (CONFIG.templateDir && CONFIG.dataTypeEnums?.length && file.startsWith(`${CONFIG.templateDir}/`) && !def.abstract && !OPTIONAL_DATATYPE.has(name)) {
      const dts = def.annotations?.templateFor?.dataType;
      if (!dts || !dts.length) add('error', 'template-datatype', `Template "${name}" has no dataType annotation (tests require one).`, { entity: name, file });
      else for (const dt of dts) if (!validDataTypes.has(dt)) add('error', 'invalid-datatype', `Template "${name}" dataType "${dt}" is not a valid Data/Metadata value.`, { entity: name, file });
    }
  }

  const counts = { error: F.filter((f) => f.severity === 'error').length, warn: F.filter((f) => f.severity === 'warn').length, info: F.filter((f) => f.severity === 'info').length };
  return { findings: F, counts };
}
app.get('/api/qc', wrap((req, res) => res.json(runQc(loadModel()))));

// ---- Model Health: actionable completeness + consistency dashboard ----
const NUMERIC_RANGE = new Set(['integer', 'float', 'double', 'decimal']);
function modelHealth(model) {
  const CAP = 300; // cap items shipped per category; UI notes truncation
  const cats = [];
  const push = (key, label, severity, help, items, extra = {}) => {
    if (!items.length && !extra.count) return;
    cats.push({ key, label, severity, help, count: extra.count ?? items.length, truncated: items.length > CAP, items: items.slice(0, CAP), ...extra });
  };
  const fx = (kind, name) => `${kind}::${name}`;
  const slots = Object.entries(model.slots);
  const classes = Object.entries(model.classes);
  const enums = Object.entries(model.enums);

  // Untyped slots (no explicit range → default string)
  const untyped = slots.filter(([, d]) => !d.range && !(Array.isArray(d.any_of) && d.any_of.some((a) => a && a.range)))
    .map(([n]) => ({ name: n, kind: 'slot', file: model.fileIndex[`slots:${n}`], detail: 'no range → defaults to string', focus: fx('slot', n) }));
  push('untyped', 'Untyped slots', 'warn', 'Slots with no explicit range fall back to string. Give them an enum, class, or scalar type.', untyped);

  // Missing descriptions (classes / slots / enums)
  const noDesc = [];
  for (const [n, d] of classes) if (!d.description) noDesc.push({ name: n, kind: 'class', file: model.fileIndex[`classes:${n}`], focus: fx('class', n) });
  for (const [n, d] of slots) if (!d.description) noDesc.push({ name: n, kind: 'slot', file: model.fileIndex[`slots:${n}`], focus: fx('slot', n) });
  for (const [n, d] of enums) if (!d.description) noDesc.push({ name: n, kind: 'enum', file: model.fileIndex[`enums:${n}`], focus: fx('enum', n) });
  push('description', 'Missing descriptions', 'info', 'Classes, slots, and value sets without a description are hard for curators to use.', noDesc);

  // Numeric slots without a unit
  const noUnit = slots.filter(([, d]) => NUMERIC_RANGE.has(String(d.range || '').toLowerCase()) && !d.unit && !d.annotations?.unit)
    .map(([n]) => ({ name: n, kind: 'slot', file: model.fileIndex[`slots:${n}`], detail: 'numeric slot with no unit', focus: fx('slot', n) }));
  push('units', 'Numeric slots missing units', 'info', 'Measurement slots should declare a unit (e.g. UCUM) so values are interpretable.', noUnit);

  // Naming inconsistency: flag slots that break the model's dominant style
  const names = slots.map(([n]) => n);
  const snake = names.filter((n) => n.includes('_')).length;
  const dominantFrac = names.length ? Math.max(snake, names.length - snake) / names.length : 1;
  // Only flag outliers when there's a strong majority style; mixed-convention models
  // (e.g. NMDC) shouldn't drown in false positives.
  if (names.length >= 12 && dominantFrac >= 0.9) {
    const majSnake = snake > names.length - snake;
    const out = names.filter((n) => n.includes('_') !== majSnake)
      .map((n) => ({ name: n, kind: 'slot', file: model.fileIndex[`slots:${n}`], detail: `doesn't match the ${majSnake ? 'snake_case' : 'camelCase'} majority`, focus: fx('slot', n) }));
    push('naming', 'Naming inconsistencies', 'info', 'Slots that don’t match the model’s dominant naming style.', out);
  }

  // Duplicated slot bundles (candidates for a shared base / mixin)
  const slotClasses = {};
  for (const [cn, d] of classes) for (const s of d.slots || []) (slotClasses[s] ??= []).push(cn);
  const bundles = {};
  for (const [s, cls] of Object.entries(slotClasses)) {
    if (cls.length < 2) continue;
    (bundles[[...new Set(cls)].sort().join('|')] ??= []).push(s);
  }
  const dup = Object.entries(bundles).filter(([, ss]) => ss.length >= 3).map(([key, ss]) => {
    const cls = key.split('|');
    return { name: `${ss.length} slots shared by ${cls.length} classes`, kind: 'bundle', detail: `${ss.slice(0, 6).join(', ')}${ss.length > 6 ? '…' : ''} — in ${cls.slice(0, 4).join(', ')}${cls.length > 4 ? '…' : ''}`, focus: fx('class', cls[0]) };
  });
  push('dedup', 'Duplicated slot bundles', 'info', 'Groups of slots repeated across classes — candidates for a shared parent or mixin.', dup);

  // Unmapped values → summary linking to the Ontology Gaps tab
  let unmapped = 0, gappy = 0;
  for (const [, d] of enums) { const u = Object.values(d.permissible_values || {}).filter((v) => !(v && v.meaning)).length; if (u) { unmapped += u; gappy++; } }
  if (unmapped) push('mapping', 'Unmapped values', 'info', 'Values with no ontology meaning: mapping. Fix them in the Ontology Gaps tab.', [], { count: unmapped, link: 'gaps', summary: `${unmapped} unmapped values across ${gappy} value sets` });

  // Structural problems (reuse the QC engine)
  const STRUCT = new Set(['undeclared-prefix', 'unknown-range', 'usage-range', 'missing-slot', 'missing-parent', 'template-datatype', 'invalid-datatype', 'empty-enum', 'url-meaning']);
  const structural = runQc(model).findings.filter((f) => STRUCT.has(f.kind))
    .map((f) => ({ name: f.entity || f.kind, kind: f.kind, file: f.file, detail: f.message, focus: f.entity && model.classes[f.entity] ? fx('class', f.entity) : (f.entity && model.enums[f.entity] ? fx('enum', f.entity) : undefined) }));
  push('structural', 'Structural problems', 'error', 'Broken references, undeclared prefixes, and validation-blocking issues.', structural);

  const totalVals = enums.reduce((a, [, d]) => a + Object.keys(d.permissible_values || {}).length, 0);
  const MP = ['exact_mappings', 'close_mappings', 'narrow_mappings', 'broad_mappings', 'related_mappings', 'mappings'];
  let semanticMappings = 0;
  for (const [, d] of [...classes, ...slots, ...enums]) {
    for (const p of MP) if (Array.isArray(d[p])) semanticMappings += d[p].length;
    if (d.class_uri || d.slot_uri) semanticMappings++;
  }
  const metrics = {
    semanticMappings,
    slots: slots.length,
    typedPct: slots.length ? Math.round((100 * (slots.length - untyped.length)) / slots.length) : 100,
    describedPct: (classes.length + slots.length + enums.length) ? Math.round((100 * (classes.length + slots.length + enums.length - noDesc.length)) / (classes.length + slots.length + enums.length)) : 100,
    values: totalVals,
    mappedPct: totalVals ? Math.round((100 * (totalVals - unmapped)) / totalVals) : 100,
  };
  return { metrics, categories: cats.sort((a, b) => ({ error: 0, warn: 1, info: 2 }[a.severity] - { error: 0, warn: 1, info: 2 }[b.severity])) };
}
app.get('/api/health', wrap((req, res) => res.json(modelHealth(loadModel()))));

// ---- Ontology (OLS4) ----
app.get('/api/ontology/search', wrap(async (req, res) => {
  const { q, ontology = '', rows, exact, branches } = req.query;
  if (!q) return res.status(400).json({ error: 'missing q' });
  res.json({ results: await searchOntology({ q, ontology, rows: Number(rows) || 12, exact: exact === 'true', branchesOnly: branches === 'true' }) });
}));

app.get('/api/ontology/descendants', wrap(async (req, res) => {
  const { ontology, iri, direct, size } = req.query;
  if (!ontology || !iri) return res.status(400).json({ error: 'need ontology and iri' });
  res.json({ terms: await getDescendants({ ontology, iri, direct: direct === 'true', size: Number(size) || 200 }) });
}));

app.get('/api/ontology/term', wrap(async (req, res) => {
  const { ontology, iri } = req.query;
  if (!ontology || !iri) return res.status(400).json({ error: 'need ontology and iri' });
  res.json({ term: await getTerm({ ontology, iri }) });
}));

app.get('/api/ontology/parents', wrap(async (req, res) => {
  const { ontology, iri } = req.query;
  if (!ontology || !iri) return res.status(400).json({ error: 'need ontology and iri' });
  res.json({ parents: await getParents({ ontology, iri }) });
}));

// Domain hint for an enum (which ontologies to scope a search to).
app.get('/api/enum-hint', wrap((req, res) => {
  const name = req.query.enum || '';
  if (Array.isArray(CONFIG.domainHints)) {                       // config-provided override rules
    for (const h of CONFIG.domainHints) { try { if (new RegExp(h.match, 'i').test(name)) return res.json({ ontology: h.ontology || '', note: h.note || '' }); } catch {} }
    return res.json({ ontology: '', note: 'Searching all ontologies' });
  }
  res.json(domainHint(name)); // built-in NF hints
}));

// ---- Prefixes (header.yaml) — for CURIE guardrails ----
app.get('/api/prefixes', wrap((req, res) => res.json({ prefixes: loadModel().prefixes || {} })));
app.post('/api/prefixes', wrap((req, res) => {
  const { prefix, uri } = req.body || {};
  if (!prefix || !uri) return res.status(400).json({ error: 'need prefix and uri' });
  if (loadModel().prefixes?.[prefix]) return res.json({ ok: true, existed: true });
  // Write to the configured header/prefixes file (not a hardcoded 'header.yaml' —
  // e.g. converted models keep it at linkml/header.yaml). Skip gracefully if none.
  if (!CONFIG.headerFile) return res.json({ ok: true, skipped: 'no headerFile configured' });
  setScalarField(CONFIG.headerFile, ['prefixes'], prefix, uri);
  res.json({ ok: true, file: CONFIG.headerFile });
}));

// ---- Add a slot to many templates at once ----
app.post('/api/classes/slot-bulk', wrap((req, res) => {
  const { slot, classes } = req.body || {};
  if (!slot || !Array.isArray(classes) || !classes.length) return res.status(400).json({ error: 'need slot and classes[]' });
  const results = classes.map((name) => {
    try { const rel = fileFor('classes', name); return { class: name, file: rel, ...addListItem(rel, ['classes', name, 'slots'], slot) }; }
    catch (e) { return { class: name, error: e.message }; }
  });
  res.json({ ok: true, results });
}));

// ---- Working-tree changes (modules + header) ----
app.get('/api/changes', wrap((req, res) => {
  exec('git status --porcelain -- modules header.yaml', { cwd: ROOT }, (err, stdout) => {
    if (err) return res.json({ files: [], error: err.message });
    const files = stdout.split('\n').filter(Boolean).map((l) => ({ status: l.slice(0, 2).trim(), path: l.slice(3) }));
    res.json({ files });
  });
}));

// ---- Terminal availability (for the drawer banner) ----
app.get('/api/terminal', (req, res) => res.json({ available: !!pty }));

// ---- Live file-watch: SSE that pushes when EXTERNAL edits touch the source ----
const watchers = new Set();
app.get('/api/watch', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(': connected\n\n');
  watchers.add(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
  req.on('close', () => { clearInterval(ping); watchers.delete(res); });
});

// ---- Create a PR from the current MODEL changes (isolated worktree off base) ----
const MODEL_PATHS = CONFIG.modelPaths;
// NB: do not trim stdout — `git status --porcelain` lines have a significant leading space.
const run = (cmd, args, opts = {}) => new Promise((resolveP, reject) =>
  execFile(cmd, args, { cwd: ROOT, maxBuffer: 32 * 1024 * 1024, ...opts },
    (e, so, se) => (e ? reject(new Error((se || '').trim() || e.message)) : resolveP(so || ''))));

app.post('/api/pr', wrap(async (req, res) => {
  const title = (req.body?.title || '').trim();
  const body = String(req.body?.body || '');
  const base = (req.body?.base || 'main').replace(/[^\w./-]/g, '');
  const branch = (req.body?.branch || '').trim().replace(/\s+/g, '-').replace(/[^\w./-]/g, '');
  if (!title) return res.status(400).json({ error: 'title is required' });
  if (!branch) return res.status(400).json({ error: 'branch is required' });

  const status = await run('git', ['status', '--porcelain', '--', ...MODEL_PATHS]);
  const lines = status.split('\n').filter(Boolean);
  if (!lines.length) return res.status(400).json({ error: 'No model changes to submit.' });

  const wt = resolve(tmpdir(), `nf-pr-${Date.now()}`);
  try {
    await run('git', ['fetch', 'origin', base]).catch(() => {});      // best-effort, ok if offline
    await run('git', ['worktree', 'add', '-b', branch, wt, `origin/${base}`]);
    for (const l of lines) {                                          // mirror each model change into the worktree
      const xy = l.slice(0, 2); const p = l.slice(3);
      const dst = resolve(wt, p);
      if (xy.includes('D')) { try { rmSync(dst); } catch {} }
      else { mkdirSync(dirname(dst), { recursive: true }); copyFileSync(resolve(ROOT, p), dst); }
    }
    await run('git', ['-C', wt, 'add', '-A', '--', ...MODEL_PATHS]);
    await run('git', ['-C', wt, 'commit', '-m', title + (body ? `\n\n${body}` : '')]);
    await run('git', ['-C', wt, 'push', '-u', 'origin', branch]);
    const out = await run('gh', ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', body || title], { cwd: wt });
    const url = out.split('\n').map((s) => s.trim()).filter(Boolean).filter((s) => s.startsWith('http')).pop() || out.trim();
    res.json({ ok: true, url, branch, files: lines.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    try { await run('git', ['worktree', 'remove', '--force', wt]); } catch {}
    try { rmSync(wt, { recursive: true, force: true }); } catch {}
  }
}));

// ---- GitHub issues (via gh, repo inferred from the git remote) ----
app.get('/api/issues', wrap((req, res) => {
  const state = ['open', 'closed', 'all'].includes(req.query.state) ? req.query.state : 'open';
  const args = ['issue', 'list', '--state', state, '--limit', '200', '--json', 'number,title,labels,state,url,updatedAt'];
  if (req.query.label) args.push('--label', String(req.query.label));
  execFile('gh', args, { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
    if (err) return res.json({ issues: [], error: err.message });
    try { res.json({ issues: JSON.parse(stdout || '[]') }); } catch (e) { res.json({ issues: [], error: e.message }); }
  });
}));
app.get('/api/issues/:n', wrap((req, res) => {
  const n = String(req.params.n).replace(/\D/g, '');
  if (!n) return res.status(400).json({ error: 'bad issue number' });
  execFile('gh', ['issue', 'view', n, '--json', 'number,title,body,labels,state,url,author,createdAt'], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
    if (err) return res.status(500).json({ error: err.message });
    try { res.json(JSON.parse(stdout)); } catch (e) { res.status(500).json({ error: e.message }); }
  });
}));

// ---- Full branch diff vs a base (default main): committed + uncommitted + new files ----
const git = (args, cb) => exec(`git ${args}`, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }, cb);
const safeBase = (b) => (b || 'main').replace(/[^\w./-]/g, '');
app.get('/api/diff', wrap((req, res) => {
  const base = safeBase(req.query.base);
  git(`diff --numstat ${base}`, (e1, numstat) => {
    git(`diff --name-status ${base}`, (e2, namestat) => {
      git('status --porcelain --untracked-files=all', (e3, status) => {
        const stat = {};
        (namestat || '').split('\n').filter(Boolean).forEach((l) => { const [s, ...p] = l.split('\t'); stat[p.join('\t')] = s[0]; });
        const files = (numstat || '').split('\n').filter(Boolean).map((l) => {
          const [a, d, ...p] = l.split('\t'); const path = p.join('\t');
          return { path, added: a === '-' ? null : +a, removed: d === '-' ? null : +d, status: stat[path] || 'M' };
        });
        const seen = new Set(files.map((f) => f.path));
        (status || '').split('\n').filter((l) => l.startsWith('?? ')).forEach((l) => {
          const p = l.slice(3); if (!seen.has(p)) files.push({ path: p, status: 'new', added: null, removed: null });
        });
        files.sort((a, b) => a.path.localeCompare(b.path));
        res.json({ base, files, error: e1 && !numstat ? e1.message : undefined });
      });
    });
  });
}));
app.get('/api/diff/file', wrap((req, res) => {
  const base = safeBase(req.query.base);
  const path = req.query.path;
  if (unsafeRel(path)) return res.status(400).json({ error: 'bad path' });
  const cmd = req.query.untracked === 'true'
    ? `diff --no-index -- /dev/null ${JSON.stringify(path)}`
    : `diff ${base} -- ${JSON.stringify(path)}`;
  git(cmd, (err, out) => res.json({ path, patch: out || '' })); // no-index exits 1 with a patch; ignore err
}));

// ---- One-click build / validate ----
function pythonBin() {
  const venv = resolve(ROOT, '.venv', 'bin', 'python');
  return existsSync(venv) ? venv : 'python3';
}
const TASK_LABELS = { ttl: 'Rebuild model', schemas: 'Generate schemas', limits: 'Check limits', tests: 'Run tests', lint: 'LinkML lint' };
const TASKS = Object.fromEntries(Object.entries(CONFIG.build).map(([k, cmd]) => [k, {
  label: TASK_LABELS[k] || k,
  cmd: () => String(cmd).replaceAll('{python}', pythonBin()),
}]));
app.post('/api/run/:task', wrap((req, res) => {
  const t = TASKS[req.params.task];
  if (!t) return res.status(400).json({ error: `unknown task ${req.params.task}` });
  const cmd = t.cmd();
  exec(cmd, { cwd: ROOT, timeout: 9 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
    const tail = (s) => (s || '').slice(-4000);
    res.json({ task: req.params.task, label: t.label, cmd, ok: !err,
      code: err?.code ?? 0, timedOut: !!err?.killed, out: tail(stdout), err: tail(stderr) });
  });
}));

// ---- Static assets ----
app.use(express.static(resolve(__dirname, 'public')));
const vendor = (name, sub) => {
  const dir = resolve(__dirname, 'node_modules', ...sub);
  if (existsSync(dir)) app.use(`/vendor/${name}`, express.static(dir));
};
vendor('cytoscape', ['cytoscape', 'dist']);
vendor('xterm', ['@xterm', 'xterm']);            // /vendor/xterm/lib/xterm.js + /css/xterm.css
vendor('xterm-fit', ['@xterm', 'addon-fit', 'lib']);

// ---- Embedded terminal: a real PTY streamed over WebSocket (for Claude Code etc.) ----
let pty = null;
try { const m = await import('node-pty'); pty = m.spawn ? m : (m.default || null); }
catch (e) { console.warn(`[terminal] node-pty unavailable (${e.message}); terminal disabled.`); }

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/terminal' });
wss.on('connection', (ws) => {
  if (!pty) {
    ws.send('node-pty is not installed. Run `npm install` in editor/ to enable the terminal.\r\n');
    ws.close(); return;
  }
  const shell = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/bash');
  let term;
  try {
    term = pty.spawn(shell, [], {
      name: 'xterm-256color', cols: 80, rows: 24, cwd: ROOT,
      env: { ...process.env, TERM: 'xterm-256color', GIT_PAGER: 'cat', PAGER: 'cat' },
    });
  } catch (e) {
    try { ws.send(`\r\nFailed to start shell (${shell}): ${e.message}\r\n`); ws.close(); } catch {}
    return;
  }
  term.onData((d) => { try { ws.send(d); } catch {} });
  term.onExit(({ exitCode }) => { try { ws.send(`\r\n[process exited (${exitCode})]\r\n`); ws.close(); } catch {} });
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'input') term.write(msg.data);
    else if (msg.type === 'resize') { try { term.resize(Math.max(2, msg.cols | 0), Math.max(2, msg.rows | 0)); } catch {} }
  });
  ws.on('close', () => { try { term.kill(); } catch {} });
});

// Convert-on-load: a schematic-CSV model is transformed into a modular LinkML repo
// (header.yaml + modules/<module>.yaml) under linkmlOutDir, and the editor then runs
// read/write on that generated LinkML — the migration path. Generated once; delete the
// output dir to regenerate. Local edits to the generated LinkML are preserved on restart.
function applySchematicConversion() {
  if (CONFIG.format !== 'schematic-csv' || CONFIG.convertToLinkml === false) return;
  const outDir = CONFIG.linkmlOutDir || 'linkml';
  const headerAbs = resolve(ROOT, outDir, 'header.yaml');
  if (!existsSync(headerAbs)) {
    const files = toLinkMLFiles(loadModel(), CONFIG.title); // loadModel() is still schematic here
    for (const [rel, content] of Object.entries(files)) {
      const abs = resolve(ROOT, outDir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    console.log(`[migrate] converted schematic CSV → LinkML: ${outDir}/ (${Object.keys(files).length} files)`);
  } else {
    console.log(`[migrate] editing existing generated LinkML in ${outDir}/ (delete to regenerate from CSV)`);
  }
  // Switch the live config to edit the generated LinkML read/write.
  CONFIG.convertedFrom = { format: 'schematic-csv', csv: CONFIG.csvModel, outDir };
  CONFIG.format = 'linkml';
  CONFIG.readOnly = false;
  CONFIG.sourceFiles = [`${outDir}/header.yaml`];
  CONFIG.sourceDirs = [`${outDir}/modules`];
  CONFIG.headerFile = `${outDir}/header.yaml`;
  CONFIG.templateDir = null;
  CONFIG.dataTypeEnums = null;
  CONFIG.dcaConfig = null;
  CONFIG.modelPaths = [outDir];
}
applySchematicConversion();

// Watch source files; push an SSE "changed" to clients on EXTERNAL edits only.
let watchTimer = null;
function notifyChanged() {
  clearTimeout(watchTimer);
  watchTimer = setTimeout(() => {
    if (Date.now() - lastApiWrite < 1500) return; // a GUI edit just happened → client already updated
    for (const res of watchers) { try { res.write('data: changed\n\n'); } catch {} }
  }, 400);
}
for (const rel of CONFIG.modelPaths || []) {
  try {
    const p = resolve(ROOT, rel);
    if (!existsSync(p)) continue;
    watch(p, { recursive: true }, notifyChanged);
  } catch (e) { console.warn(`[watch] not watching ${rel}: ${e.message}`); }
}

server.listen(PORT, () => {
  console.log(`\n  ${CONFIG.title} — model editor — http://localhost:${PORT}`);
  console.log(`  Editing source under: ${ROOT}`);
  console.log(`  Terminal: ${pty ? 'enabled' : 'disabled (node-pty missing)'} · edits write to the working tree only.\n`);
});
