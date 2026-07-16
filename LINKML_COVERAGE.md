# LinkML feature coverage

How much of the [LinkML metamodel](https://linkml.io/linkml-model/latest/docs/) the
editor can read, edit, and export today — and which gaps matter for real biomedical
schemas like NF. Use it to decide what to build next and to know what still has to be
edited in the source `.yaml` or the in-app terminal.

**Legend:** ✅ read + edit in the UI · 📖 read/display only · 🔌 handled by the write
layer (server/`patch.mjs`) but no UI control yet · ❌ not handled.

## Classes

| Metaslot | Status | Notes |
|---|---|---|
| `is_a` | ✅ | Editable; drawn as an `is_a` edge. |
| `mixins` | ✅ | Editable chips; drawn as `mixin` edges. |
| `abstract` | ✅ | Toggle (dashed border in the graph). |
| `description` | ✅ | |
| `class_uri` | ✅ | Text field. |
| `slots` | ✅ | Add/remove; add one slot to many templates at once. |
| `slot_usage` | ✅ | Per-template range / `any_of` / `required` overrides. |
| `attributes` (inline) | ✅ | Written to the owning class, not a top-level `slots:` block. |
| `aliases` | ✅ | Chip editor. |
| `exact/close/narrow/broad/related_mappings` | ✅ | SKOS predicate editor. |
| `annotations` | 🔌 | NF-specific keys (`module`, `dataType`) only; generic annotations not exposed. |
| `unique_keys` | 📖 | Displayed; no builder. |
| `rules` | 📖 | English summary; no visual builder. |
| `in_subset` | 📖 | Displayed; used for subset filtering. |
| `deprecated` | 📖 | |

## Slots

| Metaslot | Status | Notes |
|---|---|---|
| `title` | ✅ | |
| `range` | ✅ | Single range; unions (`any_of`) editable via `slot_usage`. |
| `required` | ✅ | Toggle. |
| `description` | ✅ | |
| `pattern` | ✅ | Regex text field. |
| `minimum_value` / `maximum_value` | ✅ | Numeric, type-coerced. |
| `identifier` / `key` | ✅ | Toggles. |
| `aliases` | ✅ | Chip editor. |
| `exact/close/narrow/broad/related_mappings` | ✅ | SKOS predicate editor. |
| `recommended` | 🔌 | Accepted by the PATCH API (`BOOL_FIELDS`); no UI toggle yet. |
| `multivalued` | 🔌 | Read into the graph and accepted by the API; no UI toggle yet. |
| `slot_uri` | 📖 | In graph data; not in the inspector form. |
| `structured_pattern` | 📖 | Displayed. |
| `unit` | 📖 | Displayed (from `unit:` or annotation). |
| `in_subset` | 📖 | Displayed. |
| `ifabsent` | ❌ | Default-value expressions not read or edited. |
| `domain` / `range_expression` | ❌ | Conditional/expression-based typing not handled. |
| `inlined` / `inlined_as_list` | ❌ | Serialization control not handled. |
| `equals_expression` / `string_serialization` | ❌ | Expression features not handled. |

## Enums and permissible values

| Metaslot | Status | Notes |
|---|---|---|
| `permissible_values` | ✅ | Lazy-loaded/paginated; add/remove/deprecate. |
| PV `meaning` | ✅ | Searchable; auto-mapped from OLS. |
| PV `description` | ✅ | Editable; auto-filled from OLS. |
| PV `source` | 🔌 | Written on import/add; read-only in the UI. |
| PV `aliases` | 🔌 | Written on import; read-only in the UI. |
| PV `deprecated` | ✅ | "Deprecate" button with optional reason. |
| `reachable_from` (dynamic enums) | ✅ | "Bind as dynamic enum" in the Import panel. |
| enum `aliases`, `in_subset`, `*_mappings` | ✅/📖 | Mappings editable; subset/aliases as elsewhere. |
| PV-level `*_mappings` | ❌ | Only the single `meaning:` per value is supported. |

## Schema header and types

| Metaslot | Status | Notes |
|---|---|---|
| `prefixes` | 🔌 | A prefix is auto-declared in `header.yaml` when a mapping needs it; no manual editor. |
| `imports` / `default_range` / `id` / `name` | 📖/🔌 | Set during LinkML export; not editable in the UI. |
| `subsets` | 📖 | Existing subsets drive filtering; no create/assign UI. |
| custom `types` | 📖 | Recognized as slot ranges; not editable. |

## Gaps that matter for NF, ranked

Biomedical schemas lean hard on enums, ranges, required/recommended, and inheritance —
all well covered. The gaps worth closing, most impactful first:

1. **`recommended` toggle (UI only).** NF marks many attributes "strongly suggested, not
   required." The write layer already accepts it — this is a one-checkbox add in the slot
   inspector. **Highest value / lowest effort.**
2. **`multivalued` toggle (UI only).** Multi-tissue / multi-organism slots. Also already
   wired server-side; needs a UI control.
3. **`slot_uri` field.** Semantic linking of slot definitions — mirror the existing
   `class_uri` field.
4. **Fuller LinkML export.** `linkml-export.mjs` emits a subset of metaslots; extend it so
   the schematic→LinkML migration path loses less (pattern, min/max, identifier, aliases,
   mappings, multivalued).
5. **`ifabsent` default values.** Lets curation tooling auto-populate sensible defaults.
6. **Permissible-value-level mappings.** Some values need their own exact/broad mappings
   beyond a single `meaning:`.
7. **Visual builders for `rules` / `unique_keys` / `structured_pattern`.** Currently
   display-only; edit these in the source or the terminal.

Everything marked ❌ or 📖 above can still be edited via the in-app **Terminal**
(`claude` / any CLI) or directly in the `.yaml` source — the editor never blocks the
underlying file.
