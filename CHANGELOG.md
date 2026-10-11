# Changelog

## Unreleased

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
