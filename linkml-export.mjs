/**
 * Export the editor's internal model ({classes, slots, enums}) as a LinkML schema.
 *
 * Two shapes:
 *  - toLinkMLYaml  : one merged schema document (a single downloadable .yaml).
 *  - toLinkMLFiles : a modular layout (header.yaml + modules/<module>.yaml) that
 *                    mirrors how NF/AMP-ALS/HTAN2 organize LinkML, so a schematic
 *                    model can be *converted on load* into a real editable LinkML repo.
 *
 * Works on any loaded model regardless of source dialect (LinkML in -> LinkML out is a
 * harmless re-serialization); the payoff is schematic-CSV in -> LinkML out.
 */
import yaml from 'js-yaml';

const DUMP_OPTS = { lineWidth: -1, noRefs: true, indent: 2, sortKeys: false, quotingType: '"' };

const slugify = (s) => (s || 'model').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'model';

// ---- per-entity converters (shared by both output shapes) ----
function slotToLinkml(def) {
  const s = {};
  if (def.description) s.description = def.description;
  if (def.range) s.range = def.range;
  if (def.required) s.required = true;
  if (def.multivalued) s.multivalued = true;
  return s;
}
function classToLinkml(def, model) {
  const c = {};
  if (def.description) c.description = def.description;
  const cslots = (def.slots || []).filter((s) => model.slots[s]);
  if (cslots.length) c.slots = cslots;
  const mod = def.annotations?.module?.value;
  if (mod) c.annotations = { module: { value: mod } }; // keep grouping as provenance
  return c;
}
function enumToLinkml(def) {
  const pvs = {};
  for (const [v, vdef] of Object.entries(def.permissible_values || {})) {
    const pv = {};
    if (vdef?.description) pv.description = vdef.description;
    if (vdef?.meaning) pv.meaning = vdef.meaning;
    pvs[v] = Object.keys(pv).length ? pv : null; // bare value allowed
  }
  const e = {};
  if (def.description) e.description = def.description;
  e.permissible_values = pvs;
  return e;
}

/** Prefixes actually referenced by `meaning:` CURIEs, so the schema declares them. */
function usedPrefixes(model, name) {
  const prefixes = { linkml: 'https://w3id.org/linkml/', [name]: `https://w3id.org/${name}/` };
  return prefixes; // OBO/semweb CURIEs resolve via default_curi_maps below
}

function schemaMeta(title) {
  const name = slugify(title);
  return {
    id: `https://w3id.org/${name}`,
    name,
    title,
    description: `${title} — converted to LinkML by the linkml-model-editor. Starting point for migrating this model off schematic CSV.`,
    prefixes: usedPrefixes(null, name),
    default_curi_maps: ['semweb_context', 'obo_context'],
    default_prefix: name,
    default_range: 'string',
    imports: ['linkml:types'],
  };
}

/** One merged LinkML schema object. */
export function toLinkMLObject(model, title = 'model') {
  const classes = {}; for (const [n, d] of Object.entries(model.classes)) classes[n] = classToLinkml(d, model);
  const slots = {}; for (const [n, d] of Object.entries(model.slots)) slots[n] = slotToLinkml(d);
  const enums = {}; for (const [n, d] of Object.entries(model.enums)) enums[n] = enumToLinkml(d);
  return { ...schemaMeta(title), classes, slots, enums };
}

/** One merged LinkML schema as a YAML string. */
export function toLinkMLYaml(model, title = 'model') {
  return yaml.dump(toLinkMLObject(model, title), DUMP_OPTS);
}

const moduleFile = (mod) => (slugify(mod) || 'common');

/**
 * Modular LinkML layout. Returns { 'header.yaml': str, 'modules/<mod>.yaml': str, … }.
 * Individual module files aren't independently valid (like NF's) — the editor merges
 * header + modules exactly as the Makefiles do, so cross-module refs resolve.
 */
export function toLinkMLFiles(model, title = 'model') {
  const files = { 'header.yaml': yaml.dump(schemaMeta(title), DUMP_OPTS) };
  const mi = model.moduleIndex || {};
  const groups = {}; // moduleFile -> { classes, slots, enums }
  const bucket = (mod) => (groups[mod] ??= { classes: {}, slots: {}, enums: {} });
  for (const [n, d] of Object.entries(model.classes)) bucket(moduleFile(mi[`classes:${n}`])).classes[n] = classToLinkml(d, model);
  for (const [n, d] of Object.entries(model.slots)) bucket(moduleFile(mi[`slots:${n}`])).slots[n] = slotToLinkml(d);
  for (const [n, d] of Object.entries(model.enums)) bucket(moduleFile(mi[`enums:${n}`])).enums[n] = enumToLinkml(d);
  for (const [mod, g] of Object.entries(groups)) {
    const doc = {};
    if (Object.keys(g.classes).length) doc.classes = g.classes;
    if (Object.keys(g.slots).length) doc.slots = g.slots;
    if (Object.keys(g.enums).length) doc.enums = g.enums;
    files[`modules/${mod}.yaml`] = yaml.dump(doc, DUMP_OPTS);
  }
  return files;
}

export { slugify };
