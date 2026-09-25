// JSON Template Filler
// Creates instances of local components from a JSON description and fills their layers by name.
// Works in Figma Design and Figma Buzz.

figma.showUI(__html__, { width: 460, height: 720 });

// ---------- Types ----------

type FieldValue = string | number | null | false | { text?: string; url?: string; visible?: boolean };

interface SlideSpec {
  template?: string;
  variant?: Record<string, string>;
  props?: Record<string, string | boolean>;
  fields?: Record<string, FieldValue>;
  name?: string;
  note?: string;
}

interface SetSpec {
  name?: string;
  gap?: number;
  slides?: SlideSpec[];
}

type Template = ComponentNode | ComponentSetNode;

interface TextRun { start: number; end: number; bold: boolean; italic: boolean }

const IMAGE_NAME_RE = /(image|img|immagine|foto|photo|picture|pic|cover|thumbnail|logo|avatar)/i;
const SHAPE_TYPES: NodeType[] = ['RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'VECTOR', 'FRAME'];
const BOLD_STYLES = ['Bold', 'SemiBold', 'Semi Bold', 'Semibold', 'ExtraBold', 'Extra Bold', 'Black', 'Heavy', 'Medium'];

// ---------- Markdown (**bold**, *italic*) ----------

function parseMarkdown(src: string): { text: string; runs: TextRun[] } {
  let text = '';
  const runs: TextRun[] = [];
  let bold = false;
  let italic = false;
  let runStart = 0;
  const closeRun = () => {
    if ((bold || italic) && text.length > runStart) runs.push({ start: runStart, end: text.length, bold, italic });
    runStart = text.length;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\' && (src[i + 1] === '*' || src[i + 1] === '\\')) { text += src[i + 1]; i++; continue; }
    if (c === '*' && src[i + 1] === '*') { closeRun(); bold = !bold; i++; continue; }
    if (c === '*') { closeRun(); italic = !italic; continue; }
    text += c;
  }
  closeRun();
  // Unbalanced markers: keep the raw text untouched
  if (bold || italic) return { text: src, runs: [] };
  return { text, runs };
}

// ---------- Fonts ----------

let fontListPromise: Promise<Font[]> | null = null;
const warnedFonts: Record<string, boolean> = {};

const norm = (s: string) => s.toLowerCase().replace(/[\s_-]/g, '');

async function stylesFor(family: string): Promise<string[]> {
  if (!fontListPromise) fontListPromise = figma.listAvailableFontsAsync();
  const list = await fontListPromise;
  return list.filter(f => f.fontName.family === family).map(f => f.fontName.style);
}

async function variantFont(base: FontName, bold: boolean, italic: boolean, warnings: string[]): Promise<FontName | null> {
  const styles = await stylesFor(base.family);
  const baseIsItalic = /italic/i.test(base.style);
  const baseWeight = base.style.replace(/\s*italic\s*/i, '').trim() || 'Regular';
  const weights = bold ? BOLD_STYLES : [baseWeight];
  const wantItalic = italic || baseIsItalic;
  for (const weight of weights) {
    const candidates = wantItalic
      ? [weight + ' Italic', weight + 'Italic', weight === 'Regular' ? 'Italic' : '']
      : [weight];
    for (const cand of candidates) {
      if (!cand) continue;
      const match = styles.find(s => norm(s) === norm(cand));
      if (match) {
        const f: FontName = { family: base.family, style: match };
        await figma.loadFontAsync(f);
        return f;
      }
    }
  }
  const key = base.family + (bold ? ' bold' : '') + (italic ? ' italic' : '');
  if (!warnedFonts[key]) {
    warnedFonts[key] = true;
    warnings.push(`No ${bold ? 'bold ' : ''}${italic ? 'italic ' : ''}style found for "${base.family}": formatting skipped.`);
  }
  return null;
}

async function loadFontsOf(node: TextNode): Promise<void> {
  if (node.characters.length === 0) {
    if (node.fontName !== figma.mixed) await figma.loadFontAsync(node.fontName);
    return;
  }
  const fonts = node.getRangeAllFontNames(0, node.characters.length);
  await Promise.all(fonts.map(f => figma.loadFontAsync(f)));
}

async function setRichText(node: TextNode, value: string, warnings: string[]): Promise<void> {
  await loadFontsOf(node);
  const base = node.characters.length ? node.getRangeFontName(0, 1) : node.fontName;
  const parsed = parseMarkdown(value);
  node.characters = parsed.text;
  if (!parsed.text.length || base === figma.mixed) return;
  node.setRangeFontName(0, parsed.text.length, base);
  for (const r of parsed.runs) {
    const f = await variantFont(base, r.bold, r.italic, warnings);
    if (f) node.setRangeFontName(r.start, r.end, f);
  }
}

// ---------- Images ----------

const imageCache: Record<string, Promise<Image>> = {};

function hasImageFill(n: SceneNode): boolean {
  return 'fills' in n && Array.isArray(n.fills) && (n.fills as ReadonlyArray<Paint>).some(f => f.type === 'IMAGE');
}

function isImageSlot(n: SceneNode): boolean {
  if (SHAPE_TYPES.indexOf(n.type) < 0) return false;
  if (hasImageFill(n)) return true;
  return n.type !== 'FRAME' && IMAGE_NAME_RE.test(n.name);
}

async function setImage(node: SceneNode, url: string, warnings: string[], label: string): Promise<void> {
  if (!('fills' in node)) { warnings.push(`${label}: layer "${node.name}" cannot hold an image.`); return; }
  try {
    if (!imageCache[url]) imageCache[url] = figma.createImageAsync(url);
    const img = await imageCache[url];
    (node as GeometryMixin).fills = [{ type: 'IMAGE', imageHash: img.hash, scaleMode: 'FILL' }];
  } catch (_e) {
    delete imageCache[url];
    warnings.push(`${label}: could not load image ${url}`);
  }
}

// ---------- Components ----------

async function localTemplates(): Promise<Template[]> {
  try { await figma.loadAllPagesAsync(); } catch (_e) { /* single-page editors */ }
  const nodes = figma.root.findAllWithCriteria({ types: ['COMPONENT', 'COMPONENT_SET'] }) as Template[];
  return nodes.filter(n => !(n.type === 'COMPONENT' && n.parent && n.parent.type === 'COMPONENT_SET'));
}

function pickVariant(tpl: Template, variant: Record<string, string> | undefined, warnings: string[], label: string): ComponentNode {
  if (tpl.type === 'COMPONENT') return tpl;
  if (variant && typeof variant === 'object') {
    const match = tpl.children.find(c => {
      const vp = (c as ComponentNode).variantProperties || {};
      return Object.keys(variant).every(k => String(vp[k]) === String(variant[k]));
    });
    if (match) return match as ComponentNode;
    warnings.push(`${label}: variant ${JSON.stringify(variant)} not found in "${tpl.name}", using the default one.`);
  }
  return tpl.defaultVariant;
}

function applyProps(inst: InstanceNode, props: Record<string, string | boolean>, warnings: string[], label: string): void {
  const current = inst.componentProperties || {};
  const byName: Record<string, string> = {};
  Object.keys(current).forEach(k => { byName[k.split('#')[0]] = k; });
  const update: Record<string, string | boolean> = {};
  Object.keys(props).forEach(name => {
    const full = byName[name] || (current[name] ? name : null);
    if (!full) { warnings.push(`${label}: component property "${name}" not found.`); return; }
    update[full] = props[name];
  });
  if (Object.keys(update).length) {
    try { inst.setProperties(update); } catch (e) { warnings.push(`${label}: ${e instanceof Error ? e.message : String(e)}`); }
  }
}

async function applyField(inst: InstanceNode, key: string, value: FieldValue, warnings: string[], label: string): Promise<void> {
  const targets = inst.findAll(n => n.name === key);
  if (!targets.length) { warnings.push(`${label}: no layer named "${key}".`); return; }
  for (const node of targets) {
    if (value === null || value === false) { node.visible = false; continue; }
    let v: string | number | undefined;
    if (typeof value === 'object') {
      if (value.visible === false) { node.visible = false; continue; }
      v = value.text !== undefined ? value.text : value.url;
      if (v === undefined) continue;
    } else {
      v = value;
    }
    node.visible = true;
    if (node.type === 'TEXT') {
      await setRichText(node, String(v), warnings);
    } else if (typeof v === 'string' && /^(https?:|data:image\/)/i.test(v)) {
      await setImage(node, v, warnings, label);
    } else {
      warnings.push(`${label}: "${key}" is not a text layer and the value is not an image URL.`);
    }
  }
}

// ---------- Generate ----------

async function generate(data: SetSpec | SlideSpec[]): Promise<{ count: number; warnings: string[]; notes: string[] }> {
  const slides = Array.isArray(data) ? data : data && data.slides;
  if (!Array.isArray(slides) || !slides.length) throw new Error('The JSON must contain a non-empty "slides" array.');
  const setName = (!Array.isArray(data) && data.name) || 'Generated';

  const templates = await localTemplates();
  const byName: Record<string, Template> = {};
  templates.forEach(t => { if (!byName[t.name]) byName[t.name] = t; });

  const warnings: string[] = [];
  const notes: string[] = [];
  const isBuzz = figma.editorType === 'buzz';
  let container: FrameNode | null = null;

  if (!isBuzz) {
    const frame = figma.createFrame();
    frame.name = setName;
    frame.layoutMode = 'HORIZONTAL';
    frame.primaryAxisSizingMode = 'AUTO';
    frame.counterAxisSizingMode = 'AUTO';
    frame.itemSpacing = (!Array.isArray(data) && typeof data.gap === 'number') ? data.gap : 80;
    frame.fills = [];
    let maxX = 0;
    let minY = Infinity;
    for (const c of figma.currentPage.children) {
      if (c === frame) continue;
      maxX = Math.max(maxX, c.x + c.width);
      minY = Math.min(minY, c.y);
    }
    frame.x = maxX + 200;
    frame.y = minY === Infinity ? 0 : minY;
    container = frame;
  }

  const created: InstanceNode[] = [];
  for (let i = 0; i < slides.length; i++) {
    const s = slides[i] || {};
    const label = `Slide ${i + 1}`;
    const tpl = s.template ? byName[s.template] : undefined;
    if (!tpl) { warnings.push(`${label}: template "${s.template}" not found, skipped.`); continue; }
    const master = pickVariant(tpl, s.variant, warnings, label);
    const inst = isBuzz ? figma.buzz.createInstance(master, 0) : master.createInstance();
    if (container) container.appendChild(inst);
    inst.name = s.name || `${setName} – ${String(i + 1).padStart(2, '0')}`;

    if (s.props) applyProps(inst, s.props, warnings, label);
    const fields = s.fields || {};
    for (const key of Object.keys(fields)) {
      if (key.charAt(0) === '_') continue;
      await applyField(inst, key, fields[key], warnings, label);
    }
    if (s.note) notes.push(`${label}: ${s.note}`);
    created.push(inst);
  }

  // Buzz: move everything we created into a brand-new last row, named after the set
  if (isBuzz && created.length) {
    const ids = new Set(created.map(n => n.id));
    const grid = figma.getCanvasGrid()
      .map(r => r.filter(n => !ids.has(n.id)))
      .filter(r => r.length > 0);
    grid.push(created);
    figma.setCanvasGrid(grid);
    const rowNode = created[0].parent;
    if (rowNode && rowNode.type !== 'PAGE' && rowNode.type !== 'DOCUMENT') rowNode.name = setName;
  }

  if (!created.length && container) container.remove();
  const focus: SceneNode[] = container && created.length ? [container] : created;
  if (focus.length) {
    figma.currentPage.selection = focus;
    figma.viewport.scrollAndZoomIntoView(focus);
  }
  return { count: created.length, warnings, notes };
}

// ---------- Scan ----------

function sampleText(t: TextNode): string {
  const s = t.characters.replace(/\s+/g, ' ').trim();
  return s.length > 60 ? s.slice(0, 57) + '…' : s;
}

async function scan(): Promise<{ json: string; summary: string[] }> {
  const templates = await localTemplates();
  if (!templates.length) throw new Error('No local components found in this file.');
  const example: { name: string; slides: SlideSpec[] } = { name: 'My set', slides: [] };
  const summary: string[] = [];

  for (const tpl of templates) {
    const master = tpl.type === 'COMPONENT_SET' ? tpl.defaultVariant : tpl;
    const slide: SlideSpec = { template: tpl.name };
    const info: string[] = [];

    if (tpl.type === 'COMPONENT_SET') slide.variant = Object.assign({}, master.variantProperties || {});
    const defs = tpl.componentPropertyDefinitions || {};
    const props: Record<string, string | boolean> = {};
    Object.keys(defs).forEach(k => {
      const d = defs[k];
      if (d.type === 'BOOLEAN' || d.type === 'TEXT') props[k.split('#')[0]] = d.defaultValue as string | boolean;
    });
    if (Object.keys(props).length) slide.props = props;

    const fields: Record<string, FieldValue> = {};
    const seen: Record<string, number> = {};
    master.findAll(n => n.type === 'TEXT' || isImageSlot(n)).forEach(n => {
      if (seen[n.name]) { seen[n.name]++; return; }
      seen[n.name] = 1;
      fields[n.name] = n.type === 'TEXT' ? sampleText(n) : 'https://example.com/image.jpg';
    });
    slide.fields = fields;
    const dupes = Object.keys(seen).filter(k => seen[k] > 1);
    info.push(`${Object.keys(fields).length} fields`);
    if (dupes.length) info.push('shared names: ' + dupes.join(', '));
    summary.push(`• ${tpl.name} (${info.join('; ')})`);
    example.slides.push(slide);
  }

  return { json: JSON.stringify(example, null, 2), summary };
}

// ---------- Messaging ----------

figma.ui.onmessage = async (msg: { type: string; data?: SetSpec | SlideSpec[] }) => {
  try {
    if (msg.type === 'generate') {
      const r = await generate(msg.data as SetSpec | SlideSpec[]);
      figma.ui.postMessage({ type: 'result', ok: true, message: `Created ${r.count} item(s).`, warnings: r.warnings, notes: r.notes });
    } else if (msg.type === 'scan') {
      const s = await scan();
      figma.ui.postMessage({ type: 'scan', ok: true, json: s.json, summary: s.summary });
    }
  } catch (e) {
    figma.ui.postMessage({ type: 'result', ok: false, message: e instanceof Error ? e.message : String(e) });
  }
};
