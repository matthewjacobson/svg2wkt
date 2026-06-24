/**
 * svg2wkt — convert an SVG string into a WKT (Well-Known Text) geometry string.
 *
 * Zero runtime dependencies. Works in Node, browsers, Deno and bundlers.
 *
 * Inspired by David McClure's `svg-to-wkt`, reimplemented in TypeScript with no
 * dependency on a DOM or a bezier library: SVG parsing, path sampling and arc
 * flattening are all implemented from scratch.
 */

/** Options controlling how an SVG is converted to WKT. */
export interface Svg2WktOptions {
  /**
   * Sampling density for curved geometry (circles, ellipses and path curves),
   * expressed as the number of sample points per unit of length. Higher values
   * produce smoother output at the cost of more vertices. Default `1`.
   */
  density?: number;
  /**
   * Number of decimal places to keep in output coordinates. Default `3`.
   */
  precision?: number;
  /**
   * Negate the Y axis. SVG's Y axis points down; WKT geometry is conventionally
   * Y-up, so flipping is usually desired (and matches the original `svg-to-wkt`).
   * Set to `false` to emit coordinates exactly as they appear in the SVG.
   * Default `true`.
   */
  flipY?: boolean;
  /**
   * Apply the root `<svg>`'s `viewBox` -> viewport mapping (and any nested
   * `<svg>` viewBoxes), so output coordinates are in rendered/pixel space rather
   * than raw content units. Honors `preserveAspectRatio` (meet/slice and
   * alignment). Default `false`.
   *
   * When no viewport size is resolvable (no usable `width`/`height` and no
   * {@link Svg2WktOptions.viewport} override), this falls back to a scale of 1,
   * applying only the viewBox's `min-x`/`min-y` offset.
   *
   * Providing {@link Svg2WktOptions.viewport} implies `applyViewBox: true`.
   */
  applyViewBox?: boolean;
  /**
   * Explicit viewport dimensions (in px) for the root `<svg>`, overriding its
   * `width`/`height` attributes. Useful for viewBox-only SVGs that have no
   * intrinsic size. Setting this enables {@link Svg2WktOptions.applyViewBox}.
   */
  viewport?: { width: number; height: number };
  /**
   * How to treat `<path>` subpaths that are not explicitly closed with `Z`/`z`.
   *
   * - `'auto'` (default): a subpath closed with `Z` becomes a polygon ring,
   *   while an open subpath becomes a `LINESTRING`. A path that mixes the two
   *   yields a `GEOMETRYCOLLECTION`, and several open subpaths a
   *   `MULTILINESTRING`.
   * - `'always'`: every subpath is closed into a polygon ring (matching the
   *   original `svg-to-wkt`), so a path is always emitted as a `POLYGON`.
   *
   * Only affects `<path>` elements; `<polyline>`/`<polygon>` are unaffected.
   */
  closePaths?: 'auto' | 'always';
}

interface ResolvedOptions {
  density: number;
  precision: number;
  flipY: boolean;
  applyViewBox: boolean;
  viewport: { width: number; height: number } | null;
  closePaths: 'auto' | 'always';
}

const DEFAULTS: ResolvedOptions = {
  density: 1,
  precision: 3,
  flipY: true,
  applyViewBox: false,
  viewport: null,
  closePaths: 'auto',
};

/** A 2D point. */
type Pt = [number, number];

/** Hard cap on samples per primitive, guarding against pathological input. */
const MAX_STEPS = 10000;

// ---------------------------------------------------------------------------
// Number formatting
// ---------------------------------------------------------------------------

type Formatter = (x: number, y: number) => string;

function makeFormatter(opts: ResolvedOptions): Formatter {
  const factor = 10 ** opts.precision;
  const round = (v: number): number => Math.round(v * factor) / factor;
  // `+round(...)` collapses -0 to 0 so coordinates never read "-0".
  return (x, y) => `${+round(x)} ${+round(opts.flipY ? -y : y)}`;
}

// ---------------------------------------------------------------------------
// Number / point list parsing
// ---------------------------------------------------------------------------

const NUMBER_RE = /[+-]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][+-]?\d+)?/g;

/** Parse all numbers from a string (e.g. a `points` attribute). */
function parseNumbers(input: string): number[] {
  const out: number[] = [];
  let m: RegExpExecArray | null;
  NUMBER_RE.lastIndex = 0;
  while ((m = NUMBER_RE.exec(input))) out.push(parseFloat(m[0]));
  return out;
}

/** Group a flat number list into [x, y] pairs, dropping a trailing odd value. */
function toPairs(nums: number[]): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
  return pts;
}

// ---------------------------------------------------------------------------
// 2D affine transforms
// ---------------------------------------------------------------------------

/**
 * A 2D affine transform as the 6 significant values `[a, b, c, d, e, f]`, where
 * a point maps to `(a*x + c*y + e, b*x + d*y + f)`. Same convention as SVG's
 * `matrix(...)`.
 */
type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** Compose two transforms: the result applies `n` first, then `m`. */
function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function applyMatrix(m: Matrix, x: number, y: number): Pt {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

const TRANSFORM_RE =
  /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;

/**
 * Parse an SVG `transform` attribute into a single composed matrix. Transform
 * functions are applied left-to-right (the leftmost is outermost), matching the
 * SVG specification. Returns the shared `IDENTITY` reference if nothing parses.
 */
function parseTransform(value: string): Matrix {
  let m: Matrix = IDENTITY;
  TRANSFORM_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TRANSFORM_RE.exec(value))) {
    const args = parseNumbers(match[2]);
    let t: Matrix;
    switch (match[1]) {
      case 'matrix':
        t = [args[0], args[1], args[2], args[3], args[4], args[5]];
        break;
      case 'translate':
        t = [1, 0, 0, 1, args[0] ?? 0, args[1] ?? 0];
        break;
      case 'scale': {
        const sx = args[0] ?? 1;
        const sy = args.length > 1 ? args[1] : sx;
        t = [sx, 0, 0, sy, 0, 0];
        break;
      }
      case 'rotate': {
        const a = ((args[0] ?? 0) * Math.PI) / 180;
        const cos = Math.cos(a);
        const sin = Math.sin(a);
        const rot: Matrix = [cos, sin, -sin, cos, 0, 0];
        if (args.length >= 3) {
          const cx = args[1];
          const cy = args[2];
          t = multiply([1, 0, 0, 1, cx, cy], multiply(rot, [1, 0, 0, 1, -cx, -cy]));
        } else {
          t = rot;
        }
        break;
      }
      case 'skewX':
        t = [1, 0, Math.tan(((args[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
        break;
      case 'skewY':
        t = [1, Math.tan(((args[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
        break;
      default:
        t = IDENTITY;
    }
    // Skip transforms with malformed (NaN) arguments.
    if (t.some((v) => Number.isNaN(v))) continue;
    m = m === IDENTITY ? t : multiply(m, t);
  }
  return m;
}

/** Parse an SVG length, accepting unitless and `px` values. Returns null for
 * absent values or units we don't resolve (`%`, `em`, `in`, ...). */
function parseLength(value: string | undefined): number | null {
  if (value == null) return null;
  const m = /^\s*([+-]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][+-]?\d+)?)(?:px)?\s*$/.exec(value);
  return m ? parseFloat(m[1]) : null;
}

/**
 * Compute the transform implied by an `<svg>` element's `viewBox`, viewport
 * dimensions and `preserveAspectRatio`. Returns the shared `IDENTITY` reference
 * when there is no (valid) viewBox.
 */
function computeViewBoxMatrix(
  attrs: Record<string, string>,
  viewport: { width: number; height: number } | null,
): Matrix {
  const vb = parseNumbers(attrs.viewbox ?? '');
  if (vb.length < 4) return IDENTITY;
  const [minX, minY, vbW, vbH] = vb;
  if (!(vbW > 0) || !(vbH > 0)) return IDENTITY;

  // x/y offset positions a (nested) viewport within its parent; root => 0.
  const ex = num(attrs, 'x');
  const ey = num(attrs, 'y');

  const vpW = viewport ? viewport.width : parseLength(attrs.width);
  const vpH = viewport ? viewport.height : parseLength(attrs.height);

  // No usable viewport: apply the viewBox origin offset only (scale 1).
  if (vpW == null || vpH == null || !(vpW > 0) || !(vpH > 0)) {
    return [1, 0, 0, 1, ex - minX, ey - minY];
  }

  const sx = vpW / vbW;
  const sy = vpH / vbH;

  const par = (attrs.preserveaspectratio ?? 'xMidYMid meet').trim().split(/\s+/);
  let align = par[0] || 'xMidYMid';
  let meetOrSlice = par[1] || 'meet';
  if (align === 'defer') {
    align = par[1] || 'xMidYMid';
    meetOrSlice = par[2] || 'meet';
  }

  if (align === 'none') {
    return [sx, 0, 0, sy, ex - minX * sx, ey - minY * sy];
  }

  const s = meetOrSlice === 'slice' ? Math.max(sx, sy) : Math.min(sx, sy);
  const fx = align.includes('xMid') ? 0.5 : align.includes('xMax') ? 1 : 0;
  const fy = align.includes('YMid') ? 0.5 : align.includes('YMax') ? 1 : 0;
  const tx = ex - minX * s + fx * (vpW - vbW * s);
  const ty = ey - minY * s + fy * (vpH - vbH * s);
  return [s, 0, 0, s, tx, ty];
}

// ---------------------------------------------------------------------------
// Minimal, dependency-free SVG/XML tag scanner
// ---------------------------------------------------------------------------

interface Tag {
  name: string;
  attrs: Record<string, string>;
}

const ATTR_RE = /([\w:.-]+)\s*=\s*"([^"]*)"|([\w:.-]+)\s*=\s*'([^']*)'/g;

function decodeEntities(value: string): string {
  if (value.indexOf('&') === -1) return value;
  return value.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (whole, body: string) => {
    switch (body) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
    }
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isNaN(code) ? whole : String.fromCodePoint(code);
    }
    return whole;
  });
}

function parseTag(raw: string): Tag {
  let k = 0;
  const len = raw.length;
  while (k < len && /\s/.test(raw[k])) k++;
  const start = k;
  while (k < len && !/[\s/>]/.test(raw[k])) k++;
  let name = raw.slice(start, k).toLowerCase();
  const colon = name.indexOf(':');
  if (colon >= 0) name = name.slice(colon + 1); // strip namespace prefix

  const attrs: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(raw))) {
    const key = (m[1] ?? m[3]).toLowerCase();
    const val = m[1] !== undefined ? m[2] : m[4];
    attrs[key] = decodeEntities(val);
  }
  return { name, attrs };
}

const SHAPE_NAMES = new Set([
  'line',
  'polyline',
  'polygon',
  'rect',
  'circle',
  'ellipse',
  'path',
]);

/** A shape element together with the cumulative transform that applies to it. */
interface ShapeTag extends Tag {
  matrix: Matrix;
}

/**
 * Walk an SVG string and return its basic-shape elements in document order,
 * each paired with the cumulative transform inherited from its ancestors (e.g.
 * `transform` attributes on enclosing `<g>`/`<svg>` elements) composed with its
 * own `transform`.
 *
 * Comments, CDATA, doctypes and processing instructions are skipped, and `>`
 * characters inside quoted attribute values are handled correctly. The document
 * is assumed to be well-formed XML (every element closed or self-closed).
 *
 * Note: the `viewBox`/width/height coordinate system of the root `<svg>` is not
 * applied — only `transform` attributes are.
 */
function extractShapes(
  svg: string,
  applyViewBox: boolean,
  viewport: { width: number; height: number } | null,
): ShapeTag[] {
  const shapes: ShapeTag[] = [];
  const stack: Matrix[] = []; // cumulative transform of each open container
  let seenSvg = false; // the first <svg> is the root (viewport override target)
  const n = svg.length;
  let i = 0;
  while (i < n) {
    if (svg[i] !== '<') {
      i++;
      continue;
    }
    if (svg.startsWith('<!--', i)) {
      const end = svg.indexOf('-->', i + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (svg.startsWith('<![CDATA[', i)) {
      const end = svg.indexOf(']]>', i + 9);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (svg.startsWith('<!', i) || svg.startsWith('<?', i)) {
      const end = svg.indexOf('>', i + 1);
      i = end < 0 ? n : end + 1;
      continue;
    }
    // Walk to the closing '>', respecting quoted attribute values.
    let j = i + 1;
    let quote = '';
    while (j < n) {
      const c = svg[j];
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '>') {
        break;
      }
      j++;
    }
    const raw = svg.slice(i + 1, j);
    i = j + 1;
    if (raw.length === 0) continue; // stray '<'
    if (raw[0] === '/') {
      if (stack.length) stack.pop(); // closing tag
      continue;
    }

    const selfClose = raw.replace(/\s+$/, '').endsWith('/');
    const tag = parseTag(raw);
    const parent = stack.length ? stack[stack.length - 1] : IDENTITY;
    let own = tag.attrs.transform ? parseTransform(tag.attrs.transform) : IDENTITY;

    if (applyViewBox && tag.name === 'svg') {
      // The viewBox transform establishes the coordinate system for children,
      // applied inside any transform attribute on the same element.
      const vb = computeViewBoxMatrix(tag.attrs, seenSvg ? null : viewport);
      if (vb !== IDENTITY) own = own === IDENTITY ? vb : multiply(own, vb);
    }
    if (tag.name === 'svg') seenSvg = true;

    const matrix = own === IDENTITY ? parent : multiply(parent, own);

    if (SHAPE_NAMES.has(tag.name)) shapes.push({ ...tag, matrix });
    if (!selfClose) stack.push(matrix); // descendants inherit this transform
  }
  return shapes;
}

function num(attrs: Record<string, string>, key: string, fallback = 0): number {
  const v = attrs[key];
  if (v == null) return fallback;
  const parsed = parseFloat(v);
  return Number.isNaN(parsed) ? fallback : parsed;
}

// ---------------------------------------------------------------------------
// Ring / polygon helpers
// ---------------------------------------------------------------------------

/** Format a list of points as a closed WKT ring, e.g. `(0 0,1 0,1 1,0 0)`. */
function ring(points: Pt[], fmt: Formatter): string {
  if (points.length === 0) return '';
  const coords = points.map((p) => fmt(p[0], p[1]));
  if (coords[0] !== coords[coords.length - 1]) coords.push(coords[0]);
  return `(${coords.join(',')})`;
}

/** Format a list of points as a parenthesized coordinate list (open, no close). */
function coordList(points: Pt[], fmt: Formatter): string {
  return `(${points.map((p) => fmt(p[0], p[1])).join(',')})`;
}

// ---------------------------------------------------------------------------
// Curve sampling
// ---------------------------------------------------------------------------

function steps(length: number, density: number): number {
  const s = Math.round(length * density);
  return Math.min(MAX_STEPS, Math.max(1, s));
}

function cubicAt(
  t: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
): Pt {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return [
    a * x0 + b * x1 + c * x2 + d * x3,
    a * y0 + b * y1 + c * y2 + d * y3,
  ];
}

function quadAt(
  t: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): Pt {
  const u = 1 - t;
  const a = u * u;
  const b = 2 * u * t;
  const c = t * t;
  return [a * x0 + b * x1 + c * x2, a * y0 + b * y1 + c * y2];
}

function polylineLength(sample: (t: number) => Pt, segments = 16): number {
  let length = 0;
  let prev = sample(0);
  for (let k = 1; k <= segments; k++) {
    const cur = sample(k / segments);
    length += Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
    prev = cur;
  }
  return length;
}

function sampleCubic(
  out: Pt[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
  density: number,
): void {
  const at = (t: number) => cubicAt(t, x0, y0, x1, y1, x2, y2, x3, y3);
  const n = steps(polylineLength(at), density);
  for (let k = 1; k <= n; k++) out.push(at(k / n));
}

function sampleQuad(
  out: Pt[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  density: number,
): void {
  const at = (t: number) => quadAt(t, x0, y0, x1, y1, x2, y2);
  const n = steps(polylineLength(at), density);
  for (let k = 1; k <= n; k++) out.push(at(k / n));
}

/**
 * Flatten an elliptical arc (SVG "A" command) into points using the endpoint
 * -> center parameterization from the SVG implementation notes.
 */
function sampleArc(
  out: Pt[],
  x1: number,
  y1: number,
  rxIn: number,
  ryIn: number,
  rotationDeg: number,
  largeArc: number,
  sweep: number,
  x2: number,
  y2: number,
  density: number,
): void {
  if (x1 === x2 && y1 === y2) return;
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0) {
    out.push([x2, y2]); // degenerate radii => straight line
    return;
  }

  const phi = (rotationDeg * Math.PI) / 180;
  const cosP = Math.cos(phi);
  const sinP = Math.sin(phi);

  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cosP * dx + sinP * dy;
  const y1p = -sinP * dx + cosP * dy;

  let rxs = rx * rx;
  let rys = ry * ry;
  const x1ps = x1p * x1p;
  const y1ps = y1p * y1p;

  // Scale radii up if they are too small to span the endpoints.
  const lambda = x1ps / rxs + y1ps / rys;
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
    rxs = rx * rx;
    rys = ry * ry;
  }

  const sign = largeArc !== sweep ? 1 : -1;
  let numerator = rxs * rys - rxs * y1ps - rys * x1ps;
  if (numerator < 0) numerator = 0;
  const denominator = rxs * y1ps + rys * x1ps;
  const coef = sign * Math.sqrt(numerator / denominator);
  const cxp = (coef * (rx * y1p)) / ry;
  const cyp = (coef * -(ry * x1p)) / rx;

  const cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2;
  const cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2;

  const angle = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy;
    const lens = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.min(1, Math.max(-1, dot / lens)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };

  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx;
  const vy = (-y1p - cyp) / ry;

  const theta1 = angle(1, 0, ux, uy);
  let dTheta = angle(ux, uy, vx, vy);
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
  else if (sweep && dTheta < 0) dTheta += 2 * Math.PI;

  const arcLength = Math.abs(dTheta) * ((rx + ry) / 2);
  const n = steps(arcLength, density);
  for (let k = 1; k <= n; k++) {
    const t = theta1 + dTheta * (k / n);
    const cosT = Math.cos(t);
    const sinT = Math.sin(t);
    out.push([
      cx + rx * cosT * cosP - ry * sinT * sinP,
      cy + rx * cosT * sinP + ry * sinT * cosP,
    ]);
  }
}

// ---------------------------------------------------------------------------
// SVG path data parsing
// ---------------------------------------------------------------------------

const PARAM_COUNT: Record<string, number> = {
  M: 2,
  L: 2,
  H: 1,
  V: 1,
  C: 6,
  S: 4,
  Q: 4,
  T: 2,
  A: 7,
  Z: 0,
};

interface Segment {
  cmd: string;
  params: number[];
}

/** Tokenize a path `d` string into command segments (with arc-flag handling). */
function readSegments(d: string): Segment[] {
  const segs: Segment[] = [];
  const len = d.length;
  let i = 0;
  let last = '';

  const isSep = (c: string) =>
    c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === ',';
  const skipSep = () => {
    while (i < len && isSep(d[i])) i++;
  };

  const readNumber = (): number => {
    skipSep();
    const start = i;
    if (d[i] === '+' || d[i] === '-') i++;
    let dot = false;
    while (i < len) {
      const c = d[i];
      if (c >= '0' && c <= '9') i++;
      else if (c === '.' && !dot) {
        dot = true;
        i++;
      } else break;
    }
    if (i < len && (d[i] === 'e' || d[i] === 'E')) {
      i++;
      if (d[i] === '+' || d[i] === '-') i++;
      while (i < len && d[i] >= '0' && d[i] <= '9') i++;
    }
    return parseFloat(d.slice(start, i));
  };

  const readFlag = (): number => {
    skipSep();
    const c = d[i];
    i++;
    return c === '1' ? 1 : 0;
  };

  while (i < len) {
    skipSep();
    if (i >= len) break;
    const c = d[i];
    let cmd: string;
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) {
      cmd = c;
      i++;
    } else {
      if (!last) break; // numbers before any command: malformed
      cmd = last;
    }
    const upper = cmd.toUpperCase();
    const params: number[] = [];
    if (upper === 'A') {
      params.push(
        readNumber(),
        readNumber(),
        readNumber(),
        readFlag(),
        readFlag(),
        readNumber(),
        readNumber(),
      );
    } else {
      const count = PARAM_COUNT[upper] ?? 0;
      for (let k = 0; k < count; k++) params.push(readNumber());
    }
    segs.push({ cmd, params });
    // After an explicit moveto, repeated implicit coordinates are linetos.
    last = upper === 'M' ? (cmd === 'm' ? 'l' : 'L') : cmd;
  }
  return segs;
}

/** A flattened path subpath: its sampled points and whether `Z`/`z` closed it. */
interface SubPath {
  points: Pt[];
  closed: boolean;
}

/** Flatten a path `d` attribute into a list of subpaths. */
function samplePath(d: string, density: number): SubPath[] {
  const subpaths: SubPath[] = [];
  let current: Pt[] | null = null;
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  let prevCtrlX = 0;
  let prevCtrlY = 0;
  let prevCmd = '';

  const ensure = (): Pt[] => {
    if (!current) {
      current = [[cx, cy]];
      startX = cx;
      startY = cy;
    }
    return current;
  };

  // Finalize the in-progress subpath (subpaths of a single point are dropped).
  const flush = (closed: boolean): void => {
    if (current && current.length > 1) subpaths.push({ points: current, closed });
    current = null;
  };

  for (const { cmd, params } of readSegments(d)) {
    const rel = cmd >= 'a';
    const C = cmd.toUpperCase();
    switch (C) {
      case 'M': {
        let x = params[0];
        let y = params[1];
        if (rel) {
          x += cx;
          y += cy;
        }
        flush(false);
        current = [[x, y]];
        cx = x;
        cy = y;
        startX = x;
        startY = y;
        break;
      }
      case 'L': {
        let x = params[0];
        let y = params[1];
        if (rel) {
          x += cx;
          y += cy;
        }
        ensure().push([x, y]);
        cx = x;
        cy = y;
        break;
      }
      case 'H': {
        let x = params[0];
        if (rel) x += cx;
        ensure().push([x, cy]);
        cx = x;
        break;
      }
      case 'V': {
        let y = params[0];
        if (rel) y += cy;
        ensure().push([cx, y]);
        cy = y;
        break;
      }
      case 'C': {
        let x1 = params[0];
        let y1 = params[1];
        let x2 = params[2];
        let y2 = params[3];
        let x = params[4];
        let y = params[5];
        if (rel) {
          x1 += cx;
          y1 += cy;
          x2 += cx;
          y2 += cy;
          x += cx;
          y += cy;
        }
        sampleCubic(ensure(), cx, cy, x1, y1, x2, y2, x, y, density);
        prevCtrlX = x2;
        prevCtrlY = y2;
        cx = x;
        cy = y;
        break;
      }
      case 'S': {
        let x2 = params[0];
        let y2 = params[1];
        let x = params[2];
        let y = params[3];
        if (rel) {
          x2 += cx;
          y2 += cy;
          x += cx;
          y += cy;
        }
        const reflect = prevCmd === 'C' || prevCmd === 'S';
        const x1 = reflect ? 2 * cx - prevCtrlX : cx;
        const y1 = reflect ? 2 * cy - prevCtrlY : cy;
        sampleCubic(ensure(), cx, cy, x1, y1, x2, y2, x, y, density);
        prevCtrlX = x2;
        prevCtrlY = y2;
        cx = x;
        cy = y;
        break;
      }
      case 'Q': {
        let x1 = params[0];
        let y1 = params[1];
        let x = params[2];
        let y = params[3];
        if (rel) {
          x1 += cx;
          y1 += cy;
          x += cx;
          y += cy;
        }
        sampleQuad(ensure(), cx, cy, x1, y1, x, y, density);
        prevCtrlX = x1;
        prevCtrlY = y1;
        cx = x;
        cy = y;
        break;
      }
      case 'T': {
        let x = params[0];
        let y = params[1];
        if (rel) {
          x += cx;
          y += cy;
        }
        const reflect = prevCmd === 'Q' || prevCmd === 'T';
        const x1 = reflect ? 2 * cx - prevCtrlX : cx;
        const y1 = reflect ? 2 * cy - prevCtrlY : cy;
        sampleQuad(ensure(), cx, cy, x1, y1, x, y, density);
        prevCtrlX = x1;
        prevCtrlY = y1;
        cx = x;
        cy = y;
        break;
      }
      case 'A': {
        const rx = params[0];
        const ry = params[1];
        const rot = params[2];
        const laf = params[3];
        const sf = params[4];
        let x = params[5];
        let y = params[6];
        if (rel) {
          x += cx;
          y += cy;
        }
        sampleArc(ensure(), cx, cy, rx, ry, rot, laf, sf, x, y, density);
        cx = x;
        cy = y;
        break;
      }
      case 'Z': {
        ensure().push([startX, startY]);
        cx = startX;
        cy = startY;
        // A drawing command after `Z` (without an `M`) starts a fresh subpath
        // at the current point, per the SVG path spec.
        flush(true);
        break;
      }
    }
    prevCmd = C;
  }
  flush(false);
  return subpaths;
}

// ---------------------------------------------------------------------------
// Element converters
// ---------------------------------------------------------------------------

function circlePoints(cx: number, cy: number, r: number, density: number): Pt[] {
  const circumference = 2 * Math.PI * r;
  const n = Math.min(MAX_STEPS, Math.max(3, Math.round(circumference * density)));
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

function ellipsePoints(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  density: number,
): Pt[] {
  // Ramanujan's approximation of the perimeter.
  const perimeter =
    Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry)));
  const n = Math.min(MAX_STEPS, Math.max(3, Math.round(perimeter * density)));
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI;
    pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return pts;
}

/**
 * Convert a path `d` string into a list of WKT geometries, honoring
 * `closePaths`. In `'auto'` mode, `Z`-closed subpaths form a `POLYGON` (first
 * ring exterior, the rest holes) and open subpaths become a `LINESTRING` (or
 * `MULTILINESTRING` if there are several); a path with both yields both. In
 * `'always'` mode, every subpath is a polygon ring and a single `POLYGON` is
 * returned.
 */
function pathGeometries(d: string, opts: ResolvedOptions, fmt: Formatter): string[] {
  const subpaths = samplePath(d, opts.density);
  if (subpaths.length === 0) return [];

  if (opts.closePaths === 'always') {
    const rings = subpaths.map((sp) => ring(sp.points, fmt)).filter((r) => r);
    return rings.length ? [`POLYGON(${rings.join(',')})`] : [];
  }

  const rings: string[] = [];
  const lines: string[] = [];
  for (const sp of subpaths) {
    if (sp.closed) {
      const r = ring(sp.points, fmt);
      if (r) rings.push(r);
    } else {
      lines.push(coordList(sp.points, fmt));
    }
  }

  const out: string[] = [];
  if (rings.length) out.push(`POLYGON(${rings.join(',')})`);
  if (lines.length === 1) out.push(`LINESTRING${lines[0]}`);
  else if (lines.length > 1) out.push(`MULTILINESTRING(${lines.join(',')})`);
  return out;
}

function convertElement(
  tag: Tag,
  opts: ResolvedOptions,
  fmt: Formatter,
): string[] {
  const { name, attrs } = tag;
  switch (name) {
    case 'line': {
      const x1 = num(attrs, 'x1');
      const y1 = num(attrs, 'y1');
      const x2 = num(attrs, 'x2');
      const y2 = num(attrs, 'y2');
      return [`LINESTRING(${fmt(x1, y1)},${fmt(x2, y2)})`];
    }
    case 'polyline': {
      const pts = toPairs(parseNumbers(attrs.points ?? ''));
      if (pts.length < 2) return [];
      return [`LINESTRING(${pts.map((p) => fmt(p[0], p[1])).join(',')})`];
    }
    case 'polygon': {
      const pts = toPairs(parseNumbers(attrs.points ?? ''));
      if (pts.length < 3) return [];
      return [`POLYGON(${ring(pts, fmt)})`];
    }
    case 'rect': {
      const x = num(attrs, 'x');
      const y = num(attrs, 'y');
      const w = num(attrs, 'width');
      const h = num(attrs, 'height');
      if (w <= 0 || h <= 0) return [];
      const pts: Pt[] = [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ];
      return [`POLYGON(${ring(pts, fmt)})`];
    }
    case 'circle': {
      const r = num(attrs, 'r');
      if (r <= 0) return [];
      const pts = circlePoints(num(attrs, 'cx'), num(attrs, 'cy'), r, opts.density);
      return [`POLYGON(${ring(pts, fmt)})`];
    }
    case 'ellipse': {
      const rx = num(attrs, 'rx');
      const ry = num(attrs, 'ry');
      if (rx <= 0 || ry <= 0) return [];
      const pts = ellipsePoints(
        num(attrs, 'cx'),
        num(attrs, 'cy'),
        rx,
        ry,
        opts.density,
      );
      return [`POLYGON(${ring(pts, fmt)})`];
    }
    case 'path':
      return pathGeometries(attrs.d ?? '', opts, fmt);
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert an SVG string into a WKT `GEOMETRYCOLLECTION`.
 *
 * Supported elements: `line`, `polyline`, `polygon`, `rect`, `circle`,
 * `ellipse` and `path`. Elements are emitted in document order. Unsupported
 * elements (and container/styling attributes such as `transform`) are ignored.
 *
 * @example
 * ```ts
 * svgToWkt('<svg><rect width="2" height="2"/></svg>');
 * // 'GEOMETRYCOLLECTION(POLYGON((0 0,2 0,2 -2,0 -2,0 0)))'
 * ```
 */
export function svgToWkt(svg: string, options: Svg2WktOptions = {}): string {
  const opts: ResolvedOptions = { ...DEFAULTS, ...options };
  const baseFmt = makeFormatter(opts);
  // Providing an explicit viewport implies viewBox application.
  const applyViewBox = opts.applyViewBox || opts.viewport != null;
  const geometries: string[] = [];
  for (const shape of extractShapes(svg, applyViewBox, opts.viewport)) {
    const m = shape.matrix;
    // Apply the element's cumulative transform in SVG user space before the
    // base formatter handles the optional Y-flip and rounding.
    const fmt: Formatter =
      m === IDENTITY
        ? baseFmt
        : (x, y) => {
            const p = applyMatrix(m, x, y);
            return baseFmt(p[0], p[1]);
          };
    for (const wkt of convertElement(shape, opts, fmt)) geometries.push(wkt);
  }
  return `GEOMETRYCOLLECTION(${geometries.join(',')})`;
}

/**
 * Convert a single SVG path `d` string into WKT.
 *
 * With the default `closePaths: 'auto'`, a subpath closed with `Z`/`z` becomes a
 * `POLYGON` ring (the first closed ring is the exterior, subsequent ones holes)
 * and an open subpath becomes a `LINESTRING` (or `MULTILINESTRING`). A path that
 * yields more than one top-level geometry is wrapped in a `GEOMETRYCOLLECTION`.
 * With `closePaths: 'always'`, every subpath is closed into a ring and the
 * result is always a single `POLYGON`. Returns an empty string if the path
 * yields no geometry.
 */
export function pathToWkt(d: string, options: Svg2WktOptions = {}): string {
  const opts: ResolvedOptions = { ...DEFAULTS, ...options };
  const fmt = makeFormatter(opts);
  const geoms = pathGeometries(d, opts, fmt);
  if (geoms.length === 0) return '';
  if (geoms.length === 1) return geoms[0];
  return `GEOMETRYCOLLECTION(${geoms.join(',')})`;
}

export default svgToWkt;
