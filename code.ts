// JSON Template Filler
// Creates instances of local components from a JSON description and fills their layers by name.
// Works in Figma Design and Figma Buzz.

figma.showUI(__html__, { width: 460, height: 760 });

// ---------- Types ----------

interface ValueObject {
  text?: string;        // text (supports **bold** and *italic*)
  url?: string;         // image URL, "file:name.png", "@asset:Layer" or "@keep"
  file?: string;        // name of an image dropped on the plugin
  asset?: string;       // name of a layer in this file whose image fill is copied
  visible?: boolean;
  date?: string;        // "2026-12-06T17:00" (ISO) or "06/12/2026 17:00"
  format?: string;      // "EEEE d MMMM yyyy" (see formatDate)
  locale?: string;      // it | en | de | fr | es
  case?: 'upper' | 'lower' | 'title';
  fit?: boolean | number; // shrink the font until the text fits its box (number = min font size)
}
type SingleValue = string | number | null | false | ValueObject;
// An array fills the layers with the same name one by one, in layer order
type FieldValue = SingleValue | SingleValue[];

interface ExportSpec { format?: string; scale?: number; suffix?: string }

interface SlideSpec {
  template?: string;
  variant?: Record<string, string>;
  props?: Record<string, string | boolean>;
  fields?: Record<string, FieldValue>;
  colors?: Record<string, string>;
  vars?: Record<string, string | number>;
  extends?: number | string;
  fit?: boolean | number;
  name?: string;
  note?: string;
}

interface SetSpec {
  name?: string;
  sets?: (SetSpec | SlideSpec[])[];
  gap?: number;
  layout?: 'row' | 'column' | 'byTemplate';
  colors?: Record<string, string>;
  vars?: Record<string, string | number>;
  defaults?: Record<string, SlideSpec>;
  fit?: boolean | number;
  update?: boolean;
  export?: ExportSpec | string;
  slides?: SlideSpec[];
}

type Template = ComponentNode | ComponentSetNode;

interface TextRun { start: number; end: number; bold: boolean; italic: boolean }

interface Ctx {
  images: Record<string, Uint8Array>;   // images dropped on the plugin, by file name (lower case)
  update: boolean;                       // refresh existing instances with the same name instead of creating new ones
  dryRun: boolean;                       // check only: nothing is created or changed
  warnings: string[];
  notes: string[];
  missingImages?: Record<string, string[]>; // check: image file → items that use it
}

interface ExportedFile { name: string; bytes: Uint8Array; mime: string }

const IMAGE_NAME_RE = /(image|img|immagine|foto|photo|picture|pic|cover|thumbnail|logo|avatar)/i;
const SHAPE_TYPES: NodeType[] = ['RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'VECTOR', 'FRAME'];
const BOLD_STYLES = ['Bold', 'SemiBold', 'Semi Bold', 'Semibold', 'ExtraBold', 'Extra Bold', 'Black', 'Heavy', 'Medium'];
const KEEP = '@keep';
const RECENT_KEY = 'recent';
const LAST_SET_KEY = 'jtf-last-set';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

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

const escapeMarkdown = (s: string) => s.replace(/\\/g, '\\\\').replace(/\*/g, '\\*');

// Text of a layer written back as markdown: the lightest font style is the base, heavier
// styles become **bold**, italic ones *italic*.
const WEIGHT_RANK: [RegExp, number][] = [[/hairline|thin/i, 100], [/extralight|ultralight/i, 200], [/light/i, 300], [/medium/i, 500], [/semibold|demibold/i, 600], [/extrabold|ultrabold/i, 800], [/black|heavy/i, 900], [/bold/i, 700]];
function weightRank(style: string): number {
  const w = norm(style.replace(/italic/i, ''));
  for (const [re, rank] of WEIGHT_RANK) if (re.test(w)) return rank;
  return 400;
}

function textToMarkdown(node: TextNode): string {
  const segs = node.getStyledTextSegments(['fontName']);
  if (segs.length <= 1) return escapeMarkdown(node.characters);
  const isItalic = (f: FontName) => /italic/i.test(f.style);
  const baseRank = Math.min(...segs.map(s => weightRank(s.fontName.style)));
  const baseItalic = segs.every(s => isItalic(s.fontName));
  let out = '';
  segs.forEach(s => {
    const rank = weightRank(s.fontName.style);
    const bold = rank > baseRank && rank >= 500;
    const italic = isItalic(s.fontName) && !baseItalic;
    const t = escapeMarkdown(s.characters);
    // keep the markers tight around the words, whitespace stays outside
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(t) || ['', '', t, ''];
    const open = (bold ? '**' : '') + (italic ? '*' : '');
    const close = (italic ? '*' : '') + (bold ? '**' : '');
    out += m[2].length ? m[1] + open + m[2] + close + m[3] : t;
  });
  return out;
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

// ---------- Overflow and fit ----------
// Only fixed-size text boxes can overflow. The text is measured by letting the box grow for a
// moment, then the box is put back as it was.

function overflowOf(node: TextNode): number {
  if (node.textAutoResize !== 'NONE' && node.textAutoResize !== 'TRUNCATE') return 0;
  if ('layoutSizingVertical' in node && node.layoutSizingVertical === 'FILL') return 0;
  const w = node.width, h = node.height, mode = node.textAutoResize;
  const sizing = 'layoutSizingVertical' in node ? node.layoutSizingVertical : null;
  let needed: number;
  try {
    node.textAutoResize = 'HEIGHT';
    needed = node.height;
  } finally {
    node.textAutoResize = mode;
    node.resize(w, h);
    try { if (sizing && node.layoutSizingVertical !== sizing) node.layoutSizingVertical = sizing; } catch (_e) { /* not in auto layout */ }
  }
  return Math.round(needed - h);
}

function scaleFontSize(node: TextNode, factor: number, min: number): boolean {
  let changed = false;
  for (const seg of node.getStyledTextSegments(['fontSize'])) {
    const size = Math.max(min, Math.round(seg.fontSize * factor * 2) / 2);
    if (size < seg.fontSize) { node.setRangeFontSize(seg.start, seg.end, size); changed = true; }
  }
  return changed;
}

async function fitOrWarn(node: TextNode, fit: boolean | number | undefined, warnings: string[], label: string): Promise<void> {
  let over = overflowOf(node);
  if (over <= 1) return;
  if (fit === undefined || fit === false) {
    warnings.push(`${label}: the text in "${node.name}" overflows its box by ${over}px.`);
    return;
  }
  const min = typeof fit === 'number' ? fit : 8;
  await loadFontsOf(node);
  for (let i = 0; i < 24 && over > 1; i++) {
    if (!scaleFontSize(node, 0.94, min)) break;
    over = overflowOf(node);
  }
  if (over > 1) warnings.push(`${label}: "${node.name}" still overflows by ${over}px at the minimum font size (${min}).`);
}

// ---------- Dates ----------
// formatDate("2026-12-06T17:00", "EEEE d MMMM yyyy, 'ore' HH.mm", "it") → "sabato 6 dicembre 2026, ore 17.00"

const LOCALES: Record<string, { months: string[]; days: string[] }> = {
  it: { months: ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'],
        days: ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'] },
  en: { months: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
        days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] },
  de: { months: ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'],
        days: ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'] },
  fr: { months: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
        days: ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'] },
  es: { months: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
        days: ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'] },
};
const DEFAULT_LOCALE = 'it';
const DATE_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2})[:.](\d{2}))?$/;
const DATE_RE_EU = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[T ](\d{1,2})[:.](\d{2}))?$/;

interface DateParts { y: number; m: number; d: number; H: number; M: number; wd: number }

function parseDate(s: string): DateParts | null {
  const t = String(s).trim();
  let y: number, m: number, d: number, H = 0, M = 0;
  let r = DATE_RE.exec(t);
  if (r) { y = +r[1]; m = +r[2]; d = +r[3]; if (r[4]) { H = +r[4]; M = +r[5]; } }
  else {
    r = DATE_RE_EU.exec(t);
    if (!r) return null;
    d = +r[1]; m = +r[2]; y = +r[3]; if (r[4]) { H = +r[4]; M = +r[5]; }
  }
  if (m < 1 || m > 12 || d < 1 || d > 31 || H > 23 || M > 59) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return { y, m, d, H, M, wd: date.getUTCDay() };
}

const pad2 = (n: number) => (n < 10 ? '0' : '') + n;

function formatDate(p: DateParts, format: string, locale?: string): string {
  const loc = LOCALES[(locale || DEFAULT_LOCALE).toLowerCase().slice(0, 2)] || LOCALES[DEFAULT_LOCALE];
  return format.replace(/'([^']*)'|yyyy|yy|MMMM|MMM|MM|M|EEEE|EEE|dd|d|HH|H|mm/g, (tok, lit?: string) => {
    if (lit !== undefined) return lit;
    switch (tok) {
      case 'yyyy': return String(p.y);
      case 'yy': return pad2(p.y % 100);
      case 'MMMM': return loc.months[p.m - 1];
      case 'MMM': return loc.months[p.m - 1].slice(0, 3);
      case 'MM': return pad2(p.m);
      case 'M': return String(p.m);
      case 'EEEE': return loc.days[p.wd];
      case 'EEE': return loc.days[p.wd].slice(0, 3);
      case 'dd': return pad2(p.d);
      case 'd': return String(p.d);
      case 'HH': return pad2(p.H);
      case 'H': return String(p.H);
      case 'mm': return pad2(p.M);
      default: return tok;
    }
  });
}

function applyCase(s: string, c?: string): string {
  if (c === 'upper') return s.toUpperCase();
  if (c === 'lower') return s.toLowerCase();
  if (c === 'title') return s.charAt(0).toUpperCase() + s.slice(1);
  return s;
}

const CASE_WORDS = ['upper', 'lower', 'title'];

// ---------- Variables ----------
// "{{anno}}", "{{d1|EEEE d MMMM}}", "{{d1|EEEE d MMMM|upper}}" inside any string of the JSON.

type Vars = Record<string, string | number>;
const VAR_RE = /\{\{\s*([^{}|]+?)\s*((?:\|[^{}|]*)*)\}\}/g;

function substVars(s: string, vars: Vars, locale: string | undefined, warnings: string[], label: string, warned: Record<string, boolean>): string {
  if (s.indexOf('{{') < 0) return s;
  return s.replace(VAR_RE, (whole, name: string, pipes: string) => {
    if (!(name in vars)) {
      if (!warned[name]) { warned[name] = true; warnings.push(`${label}: variable "{{${name}}}" is not defined.`); }
      return whole;
    }
    let out = String(vars[name]);
    const filters = pipes.split('|').map(f => f.trim()).filter(f => f.length);
    let caseWord: string | undefined;
    filters.forEach(f => {
      if (CASE_WORDS.indexOf(f.toLowerCase()) >= 0) { caseWord = f.toLowerCase(); return; }
      const p = parseDate(out);
      if (p) out = formatDate(p, f, locale);
      else warnings.push(`${label}: "{{${name}}}" is not a date, format "${f}" ignored.`);
    });
    return applyCase(out, caseWord);
  });
}

function substValue(v: FieldValue, vars: Vars, locale: string | undefined, warnings: string[], label: string, warned: Record<string, boolean>): FieldValue {
  if (Array.isArray(v)) return v.map(x => substValue(x, vars, locale, warnings, label, warned) as SingleValue);
  if (typeof v === 'string') return substVars(v, vars, locale, warnings, label, warned);
  if (v && typeof v === 'object') {
    const o: ValueObject = Object.assign({}, v);
    (['text', 'url', 'file', 'asset', 'date', 'format'] as const).forEach(k => {
      const x = o[k];
      if (typeof x === 'string') o[k] = substVars(x, vars, locale, warnings, label, warned);
    });
    return o;
  }
  return v;
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

const fileKey = (name: string) => name.trim().toLowerCase().replace(/^.*[\\/]/, '');

function localImage(ref: string, ctx: Ctx): Uint8Array | undefined {
  return ctx.images[fileKey(ref)];
}

// Image paints of a layer in this file ("@asset:Logo banda")
async function assetPaints(name: string, warnings: string[], label: string): Promise<Paint[] | null> {
  try { await figma.loadAllPagesAsync(); } catch (_e) { /* single-page editors */ }
  // eslint-disable-next-line @figma/figma-plugins/dynamic-page-find-method-advice -- pages loaded above
  const node = figma.root.findOne(n => n.name === name && n.type !== 'PAGE' && hasImageFill(n as SceneNode));
  if (!node) { warnings.push(`${label}: no layer named "${name}" with an image fill (for @asset:${name}).`); return null; }
  return (node as GeometryMixin).fills as Paint[];
}

function imageSpecOf(value: SingleValue): { kind: 'url' | 'file' | 'asset' | 'keep'; ref: string } | null {
  let v: string | undefined;
  if (typeof value === 'string') v = value;
  else if (value && typeof value === 'object') {
    if (value.file) return { kind: 'file', ref: value.file };
    if (value.asset) return { kind: 'asset', ref: value.asset };
    v = value.url !== undefined ? value.url : value.text;
  }
  if (typeof v !== 'string') return null;
  if (v === KEEP) return { kind: 'keep', ref: '' };
  if (/^(https?:|data:image\/)/i.test(v)) return { kind: 'url', ref: v };
  if (/^file:/i.test(v)) return { kind: 'file', ref: v.slice(5) };
  if (/^@asset:/i.test(v)) return { kind: 'asset', ref: v.slice(7) };
  if (/\.(png|jpe?g|gif|webp)$/i.test(v)) return { kind: 'file', ref: v };
  return null;
}

async function setImage(node: SceneNode, value: SingleValue, ctx: Ctx, label: string): Promise<void> {
  const warnings = ctx.warnings;
  if (!('fills' in node)) { warnings.push(`${label}: layer "${node.name}" cannot hold an image.`); return; }
  const spec = imageSpecOf(value);
  if (!spec || spec.kind === 'keep') return;
  try {
    if (spec.kind === 'asset') {
      const paints = await assetPaints(spec.ref, warnings, label);
      if (paints) (node as GeometryMixin).fills = paints;
      return;
    }
    let img: Image;
    if (spec.kind === 'file') {
      const bytes = localImage(spec.ref, ctx);
      if (!bytes) { warnings.push(`${label}: image "${spec.ref}" was not dropped on the plugin.`); return; }
      const key = 'file:' + fileKey(spec.ref);
      if (!imageCache[key]) imageCache[key] = Promise.resolve(figma.createImage(bytes));
      img = await imageCache[key];
    } else {
      if (!imageCache[spec.ref]) imageCache[spec.ref] = figma.createImageAsync(spec.ref);
      img = await imageCache[spec.ref];
    }
    (node as GeometryMixin).fills = [{ type: 'IMAGE', imageHash: img.hash, scaleMode: 'FILL' }];
  } catch (e) {
    delete imageCache[spec.kind === 'file' ? 'file:' + fileKey(spec.ref) : spec.ref];
    warnings.push(`${label}: could not load image ${spec.ref} (${errText(e)})`);
  }
}

// ---------- Components ----------

async function localTemplates(): Promise<Template[]> {
  try { await figma.loadAllPagesAsync(); } catch (_e) { /* single-page editors */ }
  // eslint-disable-next-line @figma/figma-plugins/dynamic-page-find-method-advice -- pages loaded above
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
    if (!full) { warnings.push(`${label}: component property "${name}" not found${suggest(name, Object.keys(byName))}.`); return; }
    update[full] = props[name];
  });
  if (Object.keys(update).length) {
    try { inst.setProperties(update); } catch (e) { warnings.push(`${label}: ${errText(e)}`); }
  }
}

// ---------- "Did you mean" ----------

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array<number>(n + 1);
  let cur = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const t = prev; prev = cur; cur = t;
  }
  return prev[n];
}

function closest(key: string, candidates: string[]): string | null {
  const k = key.toLowerCase();
  let best: string | null = null;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = levenshtein(k, c.toLowerCase());
    if (d < bestD) { bestD = d; best = c; }
  }
  const limit = Math.max(2, Math.floor(key.length / 3));
  return best !== null && best !== key && bestD <= limit ? best : null;
}

const suggest = (key: string, candidates: string[]) => {
  const c = closest(key, candidates);
  return c ? ` (did you mean "${c}"?)` : '';
};

// Layer names and unique paths of the fillable layers of a template, used for suggestions
function candidateKeys(root: SceneNode & ChildrenMixin): string[] {
  const seen: Record<string, number> = {};
  const nodes = root.findAll(n => n.type === 'TEXT' || isImageSlot(n));
  nodes.forEach(n => { seen[n.name] = (seen[n.name] || 0) + 1; });
  const keys: Record<string, boolean> = {};
  nodes.forEach(n => { keys[n.name] = true; if (seen[n.name] > 1) keys[uniquePath(n, root)] = true; });
  root.findAll().forEach(n => { keys[n.name] = true; });
  return Object.keys(keys);
}

// ---------- Layer paths ----------
// A field key is a layer name ("Title") or a dotted path ("Layout.Body.Event1.Title"): the last
// segment is the layer name, the others are ancestor names that must appear in that order (gaps
// allowed) between the instance and the layer. A name that exists as-is, dots included, wins.

const PATH_SEP = '.';

function ancestorNames(node: SceneNode, root: SceneNode): string[] {
  const names: string[] = [];
  let p = node.parent;
  while (p && p !== root && p.type !== 'PAGE' && p.type !== 'DOCUMENT') { names.push(p.name); p = p.parent; }
  return names; // nearest first
}

function matchesPath(node: SceneNode, root: SceneNode, ancestors: string[]): boolean {
  const chain = ancestorNames(node, root); // nearest first
  let i = ancestors.length - 1; // ancestors are given outer → inner, so walk them from the inner end
  for (const name of chain) {
    if (i < 0) break;
    if (name === ancestors[i]) i--;
  }
  return i < 0;
}

function findByKey(root: SceneNode & ChildrenMixin, key: string): SceneNode[] {
  const exact = root.findAll(n => n.name === key);
  if (exact.length || key.indexOf(PATH_SEP) < 0) return preferFillable(exact);
  const parts = key.split(PATH_SEP).map(s => s.trim()).filter(s => s.length);
  if (parts.length < 2) return exact;
  const name = parts[parts.length - 1];
  const ancestors = parts.slice(0, -1);
  return preferFillable(root.findAll(n => n.name === name && matchesPath(n, root, ancestors)));
}

// A frame called "Body" wrapping a text called "Body": the text wins. A key that matches only
// containers (e.g. "Event3": null to hide a whole block) keeps matching them.
function preferFillable(nodes: SceneNode[]): SceneNode[] {
  const fillable = nodes.filter(n => n.type === 'TEXT' || isImageSlot(n));
  return fillable.length && fillable.length < nodes.length ? fillable : nodes;
}

// Shortest dotted path that selects only this layer among the ones with the same name
// ("Event1.Title" rather than "Layout.Body.Event1.Title"). Falls back to the full path.
function uniquePath(node: SceneNode, root: SceneNode & ChildrenMixin): string {
  const chain = ancestorNames(node, root); // nearest first
  for (let k = 1; k <= chain.length; k++) {
    const ancestors = chain.slice(0, k).reverse();
    const key = ancestors.concat(node.name).join(PATH_SEP);
    if (findByKey(root, key).length === 1) return key;
  }
  return chain.slice().reverse().concat(node.name).join(PATH_SEP);
}

// ---------- Fields ----------

interface FieldOpts { fit?: boolean | number; locale?: string; soft?: boolean; candidates?: string[] }

async function applyField(inst: SceneNode & ChildrenMixin, key: string, value: FieldValue, ctx: Ctx, label: string, opts: FieldOpts): Promise<void> {
  const targets = findByKey(inst, key);
  if (!targets.length) {
    if (!opts.soft) ctx.warnings.push(`${label}: no layer named "${key}"${suggest(key, opts.candidates || candidateKeys(inst))}.`);
    return;
  }
  if (Array.isArray(value) && value.length > targets.length) ctx.warnings.push(`${label}: ${value.length} values for "${key}" but only ${targets.length} layers.`);
  for (let i = 0; i < targets.length; i++) {
    const node = targets[i];
    const item = Array.isArray(value) ? value[i] : value;
    if (item === undefined) continue;
    await applyValue(node, key, item, ctx, label, opts);
  }
}

async function applyValue(node: SceneNode, key: string, value: SingleValue, ctx: Ctx, label: string, opts: FieldOpts): Promise<void> {
  const warnings = ctx.warnings;
  if (value === null || value === false) { node.visible = false; return; }
  let v: string | number | undefined;
  let fit = opts.fit;
  if (typeof value === 'object') {
    if (value.visible === false) { node.visible = false; return; }
    if (value.fit !== undefined) fit = value.fit;
    if (value.date !== undefined) {
      const p = parseDate(String(value.date));
      if (!p) { warnings.push(`${label}: "${key}": "${value.date}" is not a valid date (use "2026-12-06T17:00").`); return; }
      v = applyCase(formatDate(p, value.format || 'd/M/yyyy', value.locale || opts.locale), value.case);
    } else if (value.file !== undefined || value.asset !== undefined) {
      v = value.file !== undefined ? 'file:' + value.file : '@asset:' + value.asset;
    } else {
      v = value.text !== undefined ? value.text : value.url;
      if (v === undefined) { if (value.visible) node.visible = true; return; }
      if (value.case && typeof v === 'string') v = applyCase(v, value.case);
    }
  } else {
    v = value;
  }
  node.visible = true;
  if (v === KEEP) return;
  const image = imageSpecOf(typeof value === 'object' ? value : v);
  if (node.type === 'TEXT') {
    await setRichText(node, String(v), warnings);
    await fitOrWarn(node, fit, warnings, label);
  } else if (image) {
    await setImage(node, typeof value === 'object' ? value : v, ctx, label);
  } else {
    warnings.push(`${label}: "${key}" is not a text layer and the value is not an image (URL, dropped file name or @asset:Layer).`);
  }
}

// ---------- Colors ----------
// "#4a9a5e": "#1e88c9" swaps a solid color everywhere (works in every editor, detaches styles).
// "Green": "Blue" swaps color styles by name (Figma Design only: Buzz plugins can't read styles).

const HEX_RE = /^#[0-9a-f]{6}$/i;

const toHex = (c: RGB) => '#' + [c.r, c.g, c.b].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
const toRgb = (hex: string): RGB => ({ r: parseInt(hex.slice(1, 3), 16) / 255, g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255 });

function swapPaints(paints: ReadonlyArray<Paint>, map: Record<string, string>, used: Record<string, boolean>): Paint[] | null {
  let changed = false;
  const out = paints.map(p => {
    if (p.type !== 'SOLID') return p;
    const from = toHex(p.color);
    if (!map[from] || map[from].toLowerCase() === from) return p;
    changed = used[from] = true;
    const { boundVariables: _bv, ...rest } = p;
    return { ...rest, color: toRgb(map[from]) };
  });
  return changed ? out : null;
}

async function applyHexColors(nodes: SceneNode[], map: Record<string, string>, warnings: string[], label: string): Promise<void> {
  const used: Record<string, boolean> = {};
  for (const node of nodes) {
    if ('fills' in node) {
      if (node.type === 'TEXT' && node.fills === figma.mixed) {
        await loadFontsOf(node);
        for (const seg of node.getStyledTextSegments(['fills'])) {
          const fills = swapPaints(seg.fills, map, used);
          if (fills) node.setRangeFills(seg.start, seg.end, fills);
        }
      } else if (Array.isArray(node.fills)) {
        const fills = swapPaints(node.fills, map, used);
        if (fills) (node as GeometryMixin).fills = fills;
      }
    }
    if ('strokes' in node) {
      const strokes = swapPaints(node.strokes, map, used);
      if (strokes) node.strokes = strokes;
    }
  }
  Object.keys(map).filter(k => !used[k] && map[k].toLowerCase() !== k).forEach(k => warnings.push(`${label}: color ${k} not used in this template.`));
}

// "Green": "Blue" maps "Green - 500" → "Blue - 500"; an exact name maps a single style.
function targetStyleName(name: string, map: Record<string, string>): string | null {
  if (map[name] !== undefined) return map[name];
  for (const key of Object.keys(map)) {
    if (name.startsWith(key) && /^[\s/_-]/.test(name.slice(key.length))) return map[key] + name.slice(key.length);
  }
  return null;
}

let paintStylesPromise: Promise<PaintStyle[]> | null = null;

async function applyStyleColors(nodes: SceneNode[], map: Record<string, string>, warnings: string[], label: string): Promise<void> {
  if (typeof figma.getLocalPaintStylesAsync !== 'function') {
    warnings.push(`${label}: color styles can't be read by plugins in this editor, use hex colors instead ("#4a9a5e": "#1e88c9").`);
    return;
  }
  if (!paintStylesPromise) paintStylesPromise = figma.getLocalPaintStylesAsync();
  const styles = await paintStylesPromise;
  const idByName: Record<string, string> = {};
  const nameById: Record<string, string> = {};
  styles.forEach(st => { idByName[st.name] = st.id; nameById[st.id] = st.name; });
  Object.keys(map).forEach(k => {
    if (!styles.some(st => targetStyleName(st.name, { [k]: '' }) !== null)) warnings.push(`${label}: no color style matches "${k}"${suggest(k, styles.map(st => st.name))}.`);
  });
  const missing: Record<string, boolean> = {};
  const swap = (id: string): string | null => {
    const from = nameById[id];
    const to = from ? targetStyleName(from, map) : null;
    if (to === null) return null;
    if (!idByName[to]) { if (!missing[to]) { missing[to] = true; warnings.push(`${label}: color style "${to}" not found.`); } return null; }
    return idByName[to];
  };

  for (const node of nodes) {
    if ('fillStyleId' in node) {
      if (node.type === 'TEXT' && node.fillStyleId === figma.mixed) {
        for (const seg of node.getStyledTextSegments(['fillStyleId'])) {
          const id = swap(seg.fillStyleId);
          if (id) await node.setRangeFillStyleIdAsync(seg.start, seg.end, id);
        }
      } else if (typeof node.fillStyleId === 'string') {
        const id = swap(node.fillStyleId);
        if (id) await node.setFillStyleIdAsync(id);
      }
    }
    if ('strokeStyleId' in node) {
      const id = swap(node.strokeStyleId);
      if (id) await node.setStrokeStyleIdAsync(id);
    }
  }
}

async function applyColors(inst: InstanceNode, map: Record<string, string>, warnings: string[], label: string): Promise<void> {
  const nodes = [inst as SceneNode].concat(inst.findAll());
  const hexMap: Record<string, string> = {};
  const styleMap: Record<string, string> = {};
  Object.keys(map).forEach(k => {
    if (k.charAt(0) !== '#') { styleMap[k] = map[k]; return; }
    if (HEX_RE.test(k) && HEX_RE.test(map[k])) hexMap[k.toLowerCase()] = map[k];
    else warnings.push(`${label}: "${k}": "${map[k]}" is not a valid color, use the #rrggbb format.`);
  });
  if (Object.keys(hexMap).length) await applyHexColors(nodes, hexMap, warnings, label);
  if (Object.keys(styleMap).length) await applyStyleColors(nodes, styleMap, warnings, label);
}

// ---------- Defaults, extends and variables ----------
// "defaults": { "*": {...}, "Evento - Post Instagram": {...} } on a set applies to every item of that
// template; "extends": 2 (item number) or "extends": "Base" (item name) copies another item.
// Merge order: defaults["*"] → defaults[template] → extended item → the item itself.

const merge = <T>(a: T | undefined, b: T | undefined): T | undefined => (a || b ? Object.assign({}, a, b) : undefined);

function mergeSlide(a: SlideSpec, b: SlideSpec): SlideSpec {
  const out: SlideSpec = {};
  out.template = b.template !== undefined ? b.template : a.template;
  out.variant = merge(a.variant, b.variant);
  out.props = merge(a.props, b.props);
  out.fields = merge(a.fields, b.fields);
  out.colors = merge(a.colors, b.colors);
  out.vars = merge(a.vars, b.vars);
  out.fit = b.fit !== undefined ? b.fit : a.fit;
  if (b.name !== undefined) out.name = b.name;
  if (b.note !== undefined) out.note = b.note;
  return out;
}

interface Resolved { slide: SlideSpec; softKeys: Record<string, boolean>; label: string }

function resolveSlide(slides: SlideSpec[], i: number, defaults: Record<string, SlideSpec>, warnings: string[], prefix: string, depth = 0): Resolved {
  const s = slides[i] || {};
  const label = `${prefix}Slide ${i + 1}`;
  let base: SlideSpec = {};
  let baseSoft: Record<string, boolean> = {};
  if (s.extends !== undefined && s.extends !== null) {
    const j = typeof s.extends === 'number' ? s.extends - 1 : slides.findIndex(x => x && x.name === s.extends);
    if (j < 0 || j >= slides.length) warnings.push(`${label}: "extends": ${JSON.stringify(s.extends)} does not match any item (use the item number or its "name").`);
    else if (j === i || depth > 10) warnings.push(`${label}: "extends" loops.`);
    else {
      const r = resolveSlide(slides, j, defaults, warnings, prefix, depth + 1);
      base = r.slide;
      baseSoft = r.softKeys;
      delete base.name; delete base.note;
    }
  }
  const tplName = s.template !== undefined ? s.template : base.template;
  const d = mergeSlide(defaults['*'] || {}, (tplName && defaults[tplName]) || {});
  // Keys that come only from defaults are "soft": a missing layer is not reported for them
  const softKeys: Record<string, boolean> = {};
  Object.keys(d.fields || {}).forEach(k => { softKeys[k] = true; });
  Object.keys(base.fields || {}).forEach(k => { if (baseSoft[k]) softKeys[k] = true; else delete softKeys[k]; });
  Object.keys(s.fields || {}).forEach(k => { delete softKeys[k]; });
  return { slide: mergeSlide(mergeSlide(d, base), s), softKeys, label };
}

// ---------- Export (PNG / JPG / PDF / SVG) ----------

function exportSpecOf(e: ExportSpec | string | undefined): ExportSpec | null {
  if (!e) return null;
  const spec: ExportSpec = typeof e === 'string' ? { format: e } : Object.assign({}, e);
  spec.format = String(spec.format || 'PNG').toUpperCase().replace('JPEG', 'JPG');
  if (['PNG', 'JPG', 'PDF', 'SVG'].indexOf(spec.format) < 0) return null;
  spec.scale = typeof spec.scale === 'number' && spec.scale > 0 ? spec.scale : 1;
  return spec;
}

const MIME: Record<string, string> = { PNG: 'image/png', JPG: 'image/jpeg', PDF: 'application/pdf', SVG: 'image/svg+xml' };

async function exportNodes(nodes: SceneNode[], spec: ExportSpec, warnings: string[]): Promise<ExportedFile[]> {
  const files: ExportedFile[] = [];
  const fmt = spec.format as 'PNG' | 'JPG' | 'PDF' | 'SVG';
  for (const n of nodes) {
    try {
      const settings: ExportSettings = fmt === 'PDF' ? { format: 'PDF' } : fmt === 'SVG' ? { format: 'SVG' } : { format: fmt, constraint: { type: 'SCALE', value: spec.scale || 1 } };
      const bytes = await n.exportAsync(settings);
      const safe = n.name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'item';
      const suffix = spec.suffix !== undefined ? spec.suffix : (fmt === 'PNG' || fmt === 'JPG') && spec.scale !== 1 ? `@${spec.scale}x` : '';
      files.push({ name: `${safe}${suffix}.${fmt.toLowerCase()}`, bytes, mime: MIME[fmt] });
    } catch (e) {
      warnings.push(`Export of "${n.name}" failed: ${errText(e)}`);
    }
  }
  return files;
}

// ---------- Generate ----------

interface Generated { created: number; updated: number; warnings: string[]; notes: string[]; focus: SceneNode[]; items: SceneNode[]; files: ExportedFile[]; report: string[] }

interface Inherited { vars: Vars; defaults: Record<string, SlideSpec>; colors: Record<string, string>; fit?: boolean | number; locale?: string }

// { "sets": [...] } generates several sets in one go, each in its own row (Buzz) or frame (Design)
async function generateAll(data: SetSpec | SlideSpec[], ctx: Ctx): Promise<Generated> {
  const total: Generated = { created: 0, updated: 0, warnings: ctx.warnings, notes: ctx.notes, focus: [], items: [], files: [], report: [] };
  const top: Inherited = { vars: {}, defaults: {}, colors: {} };
  await generateSets(data, ctx, top, '', total);
  if (ctx.missingImages) {
    Object.keys(ctx.missingImages).forEach(name => {
      const used = ctx.missingImages![name];
      total.warnings.push(`Image "${name}" has not been dropped on the plugin yet (${used.length > 3 ? used.length + ' items' : used.join(', ')}).`);
    });
  }
  if (total.focus.length && !ctx.dryRun) {
    figma.currentPage.selection = total.focus;
    figma.viewport.scrollAndZoomIntoView(total.focus);
  }
  return total;
}

async function generateSets(data: SetSpec | SlideSpec[], ctx: Ctx, parent: Inherited, prefix: string, total: Generated): Promise<void> {
  if (!Array.isArray(data) && Array.isArray(data.sets)) {
    const inh: Inherited = inherit(parent, data);
    for (const set of data.sets) {
      const name = (!Array.isArray(set) && set.name) || (!Array.isArray(data) && data.name) || 'Generated';
      await generateSets(set, ctx, inh, data.sets.length > 1 ? name + ' – ' : prefix, total);
    }
    return;
  }
  const r = await generate(data, ctx, inherit(parent, Array.isArray(data) ? {} : data), prefix);
  total.created += r.created;
  total.updated += r.updated;
  total.focus.push(...r.focus);
  total.items.push(...r.items);
  total.files.push(...r.files);
  total.report.push(...r.report);
}

function inherit(parent: Inherited, set: SetSpec): Inherited {
  return {
    vars: Object.assign({}, parent.vars, set.vars),
    defaults: Object.assign({}, parent.defaults, set.defaults),
    colors: Object.assign({}, parent.colors, set.colors),
    fit: set.fit !== undefined ? set.fit : parent.fit,
    locale: typeof set.vars?.locale === 'string' ? set.vars.locale : parent.locale,
  };
}

const isTopLevel = (n: BaseNode | null): n is SceneNode => !!n && n.parent !== null && n.parent.type === 'PAGE';

async function lastSetFrame(): Promise<SceneNode | null> {
  const id = figma.currentPage.getPluginData(LAST_SET_KEY);
  if (!id) return null;
  try {
    const n = await figma.getNodeByIdAsync(id);
    return n && !n.removed && isTopLevel(n) && n.parent === figma.currentPage ? n : null;
  } catch (_e) { return null; }
}

// New sets go under the previous generated set; the first one goes to the right of the content.
async function placeFrame(frame: FrameNode): Promise<void> {
  const last = await lastSetFrame();
  if (last) {
    frame.x = last.x;
    frame.y = last.y + last.height + 200;
  } else {
    let maxX = 0;
    let minY = Infinity;
    for (const c of figma.currentPage.children) {
      if (c === frame) continue;
      maxX = Math.max(maxX, c.x + c.width);
      minY = Math.min(minY, c.y);
    }
    frame.x = maxX + 200;
    frame.y = minY === Infinity ? 0 : minY;
  }
  figma.currentPage.setPluginData(LAST_SET_KEY, frame.id);
}

function existingInstance(name: string, master: ComponentNode): InstanceNode | null {
  const found = figma.currentPage.findAllWithCriteria({ types: ['INSTANCE'] })
    .filter(n => n.name === name && !(n.parent && n.parent.type === 'INSTANCE'));
  if (!found.length) return null;
  return found.find(n => n.getPluginData('template') === master.id) || found[0];
}

async function generate(data: SetSpec | SlideSpec[], ctx: Ctx, inh: Inherited, prefix: string): Promise<Generated> {
  const slides = Array.isArray(data) ? data : data && data.slides;
  if (!Array.isArray(slides) || !slides.length) throw new Error('The JSON must contain a non-empty "slides" array.');
  const set: SetSpec = Array.isArray(data) ? {} : data;
  const setName = set.name || 'Generated';
  const warnings = ctx.warnings;
  const notes = ctx.notes;
  const report: string[] = [];
  const update = ctx.update || set.update === true;
  const layout = set.layout === 'column' || set.layout === 'byTemplate' ? set.layout : 'row';
  const gap = typeof set.gap === 'number' ? set.gap : 80;

  const templates = await localTemplates();
  paintStylesPromise = null;
  const byName: Record<string, Template> = {};
  templates.forEach(t => { if (!byName[t.name]) byName[t.name] = t; });
  const candidatesByMaster: Record<string, string[]> = {};

  const isBuzz = figma.editorType === 'buzz';
  const box: { frame: FrameNode | null } = { frame: null };
  const rows: Record<string, FrameNode> = {};
  const getContainer = async (): Promise<FrameNode | null> => {
    if (isBuzz || ctx.dryRun) return null;
    if (!box.frame) {
      const frame = figma.createFrame();
      frame.name = setName;
      frame.layoutMode = layout === 'row' ? 'HORIZONTAL' : 'VERTICAL';
      frame.primaryAxisSizingMode = 'AUTO';
      frame.counterAxisSizingMode = 'AUTO';
      frame.itemSpacing = layout === 'byTemplate' ? gap * 2 : gap;
      frame.fills = [];
      await placeFrame(frame);
      box.frame = frame;
    }
    return box.frame;
  };
  const rowFor = async (tplName: string): Promise<FrameNode | null> => {
    const c = await getContainer();
    if (!c || layout !== 'byTemplate') return c;
    if (!rows[tplName]) {
      const row = figma.createFrame();
      row.name = tplName;
      row.layoutMode = 'HORIZONTAL';
      row.primaryAxisSizingMode = 'AUTO';
      row.counterAxisSizingMode = 'AUTO';
      row.itemSpacing = gap;
      row.fills = [];
      c.appendChild(row);
      rows[tplName] = row;
    }
    return rows[tplName];
  };

  const created: InstanceNode[] = [];
  const createdByTemplate: Record<string, InstanceNode[]> = {};
  const items: SceneNode[] = [];
  let updated = 0;

  for (let i = 0; i < slides.length; i++) {
    const { slide: s, softKeys, label } = resolveSlide(slides, i, inh.defaults, warnings, prefix);
    const vars: Vars = Object.assign({}, inh.vars, s.vars);
    const locale = typeof vars.locale === 'string' ? vars.locale : inh.locale;
    const warnedVars: Record<string, boolean> = {};
    const sv = (x: string) => substVars(x, vars, locale, warnings, label, warnedVars);

    const tplName = s.template !== undefined ? sv(String(s.template)) : undefined;
    const tpl = tplName ? byName[tplName] : undefined;
    if (!tpl) { warnings.push(`${label}: template "${tplName}" not found${suggest(String(tplName), Object.keys(byName))}, skipped.`); continue; }
    const master = pickVariant(tpl, s.variant, warnings, label);
    if (!candidatesByMaster[master.id]) candidatesByMaster[master.id] = candidateKeys(master);
    const candidates = candidatesByMaster[master.id];
    const fit = s.fit !== undefined ? s.fit : inh.fit;
    const fields = s.fields || {};
    const name = s.name ? sv(s.name) : `${setName} – ${String(i + 1).padStart(2, '0')}`;

    // Check only: report what would happen, using the main component as reference
    if (ctx.dryRun) {
      const lines: string[] = [];
      const keys = Object.keys(fields).filter(k => k.charAt(0) !== '_');
      let ok = 0;
      let skipped = 0;
      for (const key of keys) {
        const value = substValue(fields[key], vars, locale, warnings, label, warnedVars);
        const targets = findByKey(master, key);
        if (!targets.length) {
          if (!softKeys[key]) warnings.push(`${label}: no layer named "${key}"${suggest(key, candidates)}.`);
          else skipped++;
          continue;
        }
        ok++;
        if (targets.length > 1 && !Array.isArray(value)) lines.push(`"${key}" → ${targets.length} layers get the same value (use an array or a path if they differ)`);
        if (Array.isArray(value) && value.length > targets.length) warnings.push(`${label}: ${value.length} values for "${key}" but only ${targets.length} layers.`);
        const first = Array.isArray(value) ? value[0] : value;
        const img = imageSpecOf(first);
        if (img && img.kind === 'file' && !localImage(img.ref, ctx)) {
          const mi = ctx.missingImages || (ctx.missingImages = {});
          (mi[img.ref] = mi[img.ref] || []).push(label);
        }
        if (img && img.kind === 'asset') await assetPaints(img.ref, warnings, label);
        if (first && typeof first === 'object' && first.date !== undefined && !parseDate(String(first.date))) warnings.push(`${label}: "${key}": "${first.date}" is not a valid date.`);
        targets.forEach(t => {
          if (t.type !== 'TEXT' && !img && first !== null && first !== false && !(typeof first === 'object' && first.visible === false)) warnings.push(`${label}: "${key}" is not a text layer and the value is not an image.`);
        });
      }
      if (s.props) Object.keys(s.props).forEach(p => {
        const defs = tpl.componentPropertyDefinitions || {};
        if (!Object.keys(defs).some(k => k.split('#')[0] === p)) warnings.push(`${label}: component property "${p}" not found${suggest(p, Object.keys(defs).map(k => k.split('#')[0]))}.`);
      });
      const existing = update ? existingInstance(name, master) : null;
      report.push(`${label} · ${tpl.name}${tpl.type === 'COMPONENT_SET' ? ' / ' + master.name : ''}: ${ok}/${keys.length - skipped} fields match${skipped ? ` (${skipped} default${skipped > 1 ? 's' : ''} not in this template)` : ''}${update ? existing ? ' · updates "' + name + '"' : ' · creates "' + name + '"' : ''}${lines.length ? ' · ' + lines.join(' · ') : ''}`);
      continue;
    }

    let inst: InstanceNode | null = update ? existingInstance(name, master) : null;
    if (inst) {
      try {
        inst.resetOverrides();
        const main = await inst.getMainComponentAsync();
        if (!main || main.id !== master.id) inst.swapComponent(master);
      } catch (e) { warnings.push(`${label}: could not reset "${name}" (${errText(e)}).`); }
      updated++;
    } else {
      inst = isBuzz ? figma.buzz.createInstance(master, 0) : master.createInstance();
      const parentFrame = await rowFor(tpl.name);
      if (parentFrame) parentFrame.appendChild(inst);
      created.push(inst);
      (createdByTemplate[tpl.name] = createdByTemplate[tpl.name] || []).push(inst);
    }
    inst.name = name;
    inst.setPluginData('template', master.id);

    if (s.props) applyProps(inst, s.props, warnings, label);
    for (const key of Object.keys(fields)) {
      if (key.charAt(0) === '_') continue;
      const value = substValue(fields[key], vars, locale, warnings, label, warnedVars);
      await applyField(inst, key, value, ctx, label, { fit, locale, soft: !!softKeys[key], candidates });
    }
    const colors = Object.assign({}, inh.colors, s.colors);
    if (Object.keys(colors).length) await applyColors(inst, colors, warnings, label);
    if (s.note) notes.push(`${label}: ${sv(s.note)}`);
    items.push(inst);
  }

  // Buzz: move everything we created into brand-new rows at the bottom, named after the set
  if (isBuzz && created.length) {
    const ids = new Set(created.map(n => n.id));
    const grid = figma.getCanvasGrid()
      .map(r => r.filter(n => !ids.has(n.id)))
      .filter(r => r.length > 0);
    const groups = layout === 'byTemplate' ? Object.keys(createdByTemplate).map(k => ({ name: `${setName} – ${k}`, nodes: createdByTemplate[k] })) : [{ name: setName, nodes: created }];
    groups.forEach(g => grid.push(g.nodes));
    figma.setCanvasGrid(grid);
    groups.forEach(g => {
      const rowNode = g.nodes[0].parent;
      if (rowNode && rowNode.type !== 'PAGE' && rowNode.type !== 'DOCUMENT') rowNode.name = g.name;
    });
  }

  if (box.frame && !created.length) { box.frame.remove(); box.frame = null; }
  const focus: SceneNode[] = box.frame ? [box.frame] : items;
  const spec = exportSpecOf(set.export);
  const files = spec && items.length && !ctx.dryRun ? await exportNodes(items, spec, warnings) : [];
  return { created: created.length, updated, warnings, notes, focus, items, files, report };
}

// ---------- Scan ----------

// Solid colors of a template, as the left side of a "colors" swap. Prefers the colors linked to a
// color style (the palette), so logos and illustrations don't flood the list.
function templateColors(root: SceneNode & ChildrenMixin): string[] {
  const styled: Record<string, boolean> = {};
  const all: Record<string, boolean> = {};
  const add = (paints: ReadonlyArray<Paint>, styleId: string) => paints.forEach(p => {
    if (p.type !== 'SOLID') return;
    all[toHex(p.color)] = true;
    if (styleId) styled[toHex(p.color)] = true;
  });
  [root as SceneNode].concat(root.findAll()).forEach(n => {
    if ('fills' in n) {
      if (n.type === 'TEXT' && n.fills === figma.mixed) n.getStyledTextSegments(['fills', 'fillStyleId']).forEach(seg => add(seg.fills, seg.fillStyleId));
      else if (Array.isArray(n.fills)) add(n.fills, typeof n.fillStyleId === 'string' ? n.fillStyleId : '');
    }
    if ('strokes' in n) add(n.strokes, n.strokeStyleId);
  });
  return Object.keys(Object.keys(styled).length ? styled : all);
}

function sampleText(t: TextNode): string {
  const s = t.characters.replace(/\s+/g, ' ').trim();
  return s.length > 60 ? s.slice(0, 57) + '…' : s;
}

// Fillable layers of an instance or component, keyed by name or by unique path when names repeat
function fillableKeys(root: SceneNode & ChildrenMixin): { key: string; node: SceneNode }[] {
  const seen: Record<string, number> = {};
  const fillable = root.findAll(n => n.type === 'TEXT' || isImageSlot(n));
  fillable.forEach(n => { seen[n.name] = (seen[n.name] || 0) + 1; });
  const used: Record<string, boolean> = {};
  const out: { key: string; node: SceneNode }[] = [];
  fillable.forEach(n => {
    const key = seen[n.name] > 1 ? uniquePath(n, root) : n.name;
    if (used[key]) return;
    used[key] = true;
    out.push({ key, node: n });
  });
  return out;
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
    const keys = fillableKeys(master);
    keys.forEach(({ key, node }) => { fields[key] = node.type === 'TEXT' ? sampleText(node) : 'https://example.com/image.jpg'; });
    slide.fields = fields;
    const dupes = keys.filter(k => k.key.indexOf(PATH_SEP) >= 0).map(k => k.node.name).filter((v, i, a) => a.indexOf(v) === i);
    info.push(`${keys.length} fields`);
    const colors = templateColors(master);
    if (colors.length) {
      slide.colors = {};
      colors.forEach(c => { slide.colors![c] = c; });
      info.push(`${colors.length} colors`);
    }
    if (dupes.length) info.push('shared names, listed as paths: ' + dupes.join(', '));
    summary.push(`• ${tpl.name} (${info.join('; ')})`);
    example.slides.push(slide);
  }

  return { json: JSON.stringify(example, null, 2), summary };
}

// ---------- Export JSON from the selection ----------

function selectedInstances(): InstanceNode[] {
  const out: InstanceNode[] = [];
  const add = (n: SceneNode) => {
    if (n.type === 'INSTANCE') { out.push(n); return; }
    if ('children' in n) n.children.forEach(add);
  };
  figma.currentPage.selection.forEach(add);
  return out;
}

async function exportJson(): Promise<{ json: string; count: number }> {
  const instances = selectedInstances();
  if (!instances.length) throw new Error('Select the generated items (or their frame) first.');
  const sel = figma.currentPage.selection;
  const name = sel.length === 1 && sel[0].type === 'FRAME' ? sel[0].name : 'Exported';
  const slides: SlideSpec[] = [];
  for (const inst of instances) {
    const main = await inst.getMainComponentAsync();
    if (!main) continue;
    const set = main.parent && main.parent.type === 'COMPONENT_SET' ? main.parent : null;
    const slide: SlideSpec = { template: set ? set.name : main.name };
    if (set) slide.variant = Object.assign({}, main.variantProperties || {});
    const props: Record<string, string | boolean> = {};
    const cp = inst.componentProperties || {};
    Object.keys(cp).forEach(k => { if (cp[k].type === 'BOOLEAN' || cp[k].type === 'TEXT') props[k.split('#')[0]] = cp[k].value as string | boolean; });
    if (Object.keys(props).length) slide.props = props;
    const fields: Record<string, FieldValue> = {};
    fillableKeys(inst).forEach(({ key, node }) => {
      if (!node.visible) { fields[key] = null; return; }
      fields[key] = node.type === 'TEXT' ? textToMarkdown(node) : KEEP;
    });
    slide.fields = fields;
    slide.name = inst.name;
    slides.push(slide);
  }
  return { json: JSON.stringify({ name, slides }, null, 2), count: slides.length };
}

// ---------- Recent JSONs ----------

interface RecentItem { name: string; at: number; json: string }
const RECENT_MAX = 8;
const RECENT_MAX_LEN = 300000;

async function recentList(): Promise<RecentItem[]> {
  try {
    const v = await figma.clientStorage.getAsync(RECENT_KEY);
    return Array.isArray(v) ? v as RecentItem[] : [];
  } catch (_e) { return []; }
}

async function recentAdd(name: string, json: string): Promise<RecentItem[]> {
  if (json.length > RECENT_MAX_LEN) return recentList();
  const list = (await recentList()).filter(r => r.json !== json);
  list.unshift({ name: name || 'Untitled', at: Date.now(), json });
  const trimmed = list.slice(0, RECENT_MAX);
  try { await figma.clientStorage.setAsync(RECENT_KEY, trimmed); } catch (_e) { /* storage full */ }
  return trimmed;
}

// ---------- Messaging ----------

interface UiMessage {
  type: string;
  data?: SetSpec | SlideSpec[];
  images?: Record<string, Uint8Array>;
  update?: boolean;
  format?: string;
  scale?: number;
  name?: string;
  json?: string;
}

function imageMap(images?: Record<string, Uint8Array>): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  if (images) Object.keys(images).forEach(k => { out[fileKey(k)] = images[k]; });
  return out;
}

const setNameOf = (data: SetSpec | SlideSpec[] | undefined) => (data && !Array.isArray(data) && data.name) || '';

figma.ui.onmessage = async (msg: UiMessage) => {
  try {
    if (msg.type === 'generate') {
      const ctx: Ctx = { images: imageMap(msg.images), update: !!msg.update, dryRun: false, warnings: [], notes: [] };
      const r = await generateAll(msg.data as SetSpec | SlideSpec[], ctx);
      const parts: string[] = [];
      if (r.created) parts.push(`created ${r.created}`);
      if (r.updated) parts.push(`updated ${r.updated}`);
      const message = (parts.length ? parts.join(', ') : 'nothing created') + ' item(s).';
      figma.ui.postMessage({ type: 'result', ok: true, message: message.charAt(0).toUpperCase() + message.slice(1), warnings: r.warnings, notes: r.notes, files: r.files });
      if (msg.json) { const recent = await recentAdd(setNameOf(msg.data), msg.json); figma.ui.postMessage({ type: 'recent', items: recent.map(x => ({ name: x.name, at: x.at })) }); }
    } else if (msg.type === 'check') {
      const ctx: Ctx = { images: imageMap(msg.images), update: !!msg.update, dryRun: true, warnings: [], notes: [] };
      const r = await generateAll(msg.data as SetSpec | SlideSpec[], ctx);
      figma.ui.postMessage({ type: 'check', ok: true, message: r.warnings.length ? `${r.report.length} item(s) checked, ${r.warnings.length} issue(s).` : `${r.report.length} item(s) checked, no issues. Nothing was created.`, report: r.report, warnings: r.warnings, notes: r.notes });
    } else if (msg.type === 'scan') {
      const s = await scan();
      figma.ui.postMessage({ type: 'scan', ok: true, json: s.json, summary: s.summary });
    } else if (msg.type === 'export-json') {
      const r = await exportJson();
      figma.ui.postMessage({ type: 'export-json', ok: true, json: r.json, message: `${r.count} item(s) read from the selection.` });
    } else if (msg.type === 'export-images') {
      const spec = exportSpecOf({ format: msg.format, scale: msg.scale });
      if (!spec) throw new Error('Export format must be PNG, JPG, PDF or SVG.');
      const nodes = selectedInstances();
      if (!nodes.length) throw new Error('Select the items to export (or their frame) first.');
      const warnings: string[] = [];
      const files = await exportNodes(nodes, spec, warnings);
      figma.ui.postMessage({ type: 'export-images', ok: true, files, warnings, message: `${files.length} file(s) exported.` });
    } else if (msg.type === 'recent-get') {
      const list = await recentList();
      figma.ui.postMessage({ type: 'recent', items: list.map(x => ({ name: x.name, at: x.at })) });
    } else if (msg.type === 'recent-load') {
      const list = await recentList();
      const item = list[Number(msg.name)];
      if (item) figma.ui.postMessage({ type: 'recent-json', ok: true, json: item.json });
    } else if (msg.type === 'recent-clear') {
      try { await figma.clientStorage.deleteAsync(RECENT_KEY); } catch (_e) { /* nothing stored */ }
      figma.ui.postMessage({ type: 'recent', items: [] });
    }
  } catch (e) {
    const where = e instanceof Error && e.stack ? (e.stack.split('\n').find(l => /at /.test(l)) || '').trim() : '';
    figma.ui.postMessage({ type: 'result', ok: false, message: errText(e) + (where ? ` (${where})` : '') });
  }
};
