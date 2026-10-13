# Changelog

## Unreleased

- **Check**: dry run that reports, per item, matching fields, unknown keys (with a "did you mean" suggestion), fields sending one value to several layers, missing dropped images and invalid dates. Nothing is created.
- Images from files dropped on the plugin (`"foto.png"` / `"file:foto.png"`), from a layer of the file (`"@asset:Logo"`) and `"@keep"` to leave a layer untouched.
- **Update existing items with the same name** (checkbox or `"update": true`): instances are reset and refilled in place, the component is swapped if the template changed.
- **JSON from selection**: the JSON of the selected generated items, bold/italic reconstructed from the font styles, `null` for hidden layers, `"@keep"` for images.
- Dates: `{ "date": "2026-12-06T17:00", "format": "EEEE d MMMM yyyy" }` with locales it/en/de/fr/es, `'literal'` text and `case`.
- Variables: `"vars"` on sets and items, `{{name}}`, `{{date|format}}`, `|upper` / `|lower` / `|title`.
- `"defaults"` per template (and `"*"`) on sets and `"extends"` (item number or name) on items.
- Export PNG/JPG (1–4x), PDF and SVG of the selection from the UI, or right after generation with `"export"`.
- Figma Design: each new set goes under the previous one; `"layout": "row" | "column" | "byTemplate"` (one row per template, also in Buzz).
- Overflow warning for fixed-size text boxes; `"fit": true` (or a minimum size) shrinks the font until the text fits, on set, item or value.
- "Did you mean" suggestions for unknown layers, templates, component properties and color styles.
- Editor: the line of a JSON error (click the badge to jump there), hints on unknown or missing keys, recent JSONs in the **Recent…** menu, image drop zone.
- Dotted layer paths in `fields` (`"Event1.Title"`, `"Layout.Body.Event2.Title"`) to fill one of several layers that share a name; plain names and arrays keep working. Scan writes shared names as the shortest unique path.
- `colors`: swap colors for the whole set or a single item, by hex value (`"#4a9a5e": "#1e88c9"`, every editor) or by color style name (`"Green": "Blue"`, Figma Design only).
- Scan adds the colors of each template to the example JSON, ready to be swapped.
- An array as a field value fills the layers with the same name one by one.
- `sets`: generate several sets from one JSON.
- Error messages show where the error happened.

## 1.0.0 – 2026-09-25

First public release.

- Scan local components and component sets, with an example JSON of all fillable layers.
- Generate one instance per item, filling text and image layers by name.
- `**bold**` and `*italic*` in text, using the styles of the template font.
- `null` hides a layer; `variant` and `props` for component sets and component properties.
- `note` reminders shown after generation.
- Figma Buzz: each set goes to a new row at the bottom of the canvas grid, named after the set.
- Figma Design: each set goes to a new auto-layout frame.
- Live JSON validation, drag and drop of `.json` files, Ctrl/⌘ + Enter to generate.
