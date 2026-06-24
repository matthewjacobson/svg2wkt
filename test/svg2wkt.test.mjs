import test from 'node:test';
import assert from 'node:assert/strict';

import svgToWktDefault, { svgToWkt, pathToWkt } from '../dist/esm/index.js';

test('default export and named export are the same function', () => {
  assert.equal(svgToWktDefault, svgToWkt);
});

test('rect -> POLYGON with default Y flip', () => {
  const wkt = svgToWkt('<svg><rect x="0" y="0" width="2" height="2"/></svg>');
  assert.equal(wkt, 'GEOMETRYCOLLECTION(POLYGON((0 0,2 0,2 -2,0 -2,0 0)))');
});

test('flipY:false preserves raw coordinates', () => {
  const wkt = svgToWkt('<svg><rect x="1" y="1" width="2" height="3"/></svg>', {
    flipY: false,
  });
  assert.equal(wkt, 'GEOMETRYCOLLECTION(POLYGON((1 1,3 1,3 4,1 4,1 1)))');
});

test('line -> LINESTRING', () => {
  const wkt = svgToWkt('<line x1="0" y1="0" x2="10" y2="5"/>', { flipY: false });
  assert.equal(wkt, 'GEOMETRYCOLLECTION(LINESTRING(0 0,10 5))');
});

test('polyline -> LINESTRING (comma and space separated points)', () => {
  const wkt = svgToWkt('<polyline points="0,0 10,0 10,10"/>', { flipY: false });
  assert.equal(wkt, 'GEOMETRYCOLLECTION(LINESTRING(0 0,10 0,10 10))');
});

test('polygon -> closed POLYGON', () => {
  const wkt = svgToWkt('<polygon points="0,0 10,0 10,10"/>', { flipY: false });
  assert.equal(wkt, 'GEOMETRYCOLLECTION(POLYGON((0 0,10 0,10 10,0 0)))');
});

test('circle is approximated by a polygon honoring density', () => {
  const wkt = svgToWkt('<circle cx="0" cy="0" r="10"/>', { density: 0.1 });
  const match = wkt.match(/\(\(([^)]*)\)\)/);
  assert.ok(match, 'expected a polygon');
  const ringPts = match[1].split(',');
  // circumference ~62.8, density 0.1 => ~6 points, plus closing vertex.
  assert.ok(ringPts.length >= 6 && ringPts.length <= 8, `got ${ringPts.length}`);
  assert.equal(ringPts[0], ringPts[ringPts.length - 1], 'ring must be closed');
});

test('ellipse is approximated by a polygon', () => {
  const wkt = svgToWkt('<ellipse cx="0" cy="0" rx="10" ry="5"/>', { density: 0.2 });
  assert.match(wkt, /^GEOMETRYCOLLECTION\(POLYGON\(\(/);
});

test('path with absolute lineto and close -> POLYGON', () => {
  const wkt = pathToWkt('M0 0 L10 0 L10 10 Z', { flipY: false });
  assert.equal(wkt, 'POLYGON((0 0,10 0,10 10,0 0))');
});

test('path relative commands resolve against current point', () => {
  const wkt = pathToWkt('m0 0 l10 0 l0 10 z', { flipY: false });
  assert.equal(wkt, 'POLYGON((0 0,10 0,10 10,0 0))');
});

test('path H and V commands', () => {
  const wkt = pathToWkt('M0 0 H10 V10 H0 Z', { flipY: false });
  assert.equal(wkt, 'POLYGON((0 0,10 0,10 10,0 10,0 0))');
});

test('compound path produces multiple rings (exterior + hole)', () => {
  const d = 'M0 0 H10 V10 H0 Z M2 2 H8 V8 H2 Z';
  const wkt = pathToWkt(d, { flipY: false });
  assert.equal(
    wkt,
    'POLYGON((0 0,10 0,10 10,0 10,0 0),(2 2,8 2,8 8,2 8,2 2))',
  );
});

test('cubic bezier path samples interior points', () => {
  const wkt = pathToWkt('M0 0 C0 10 10 10 10 0', { flipY: false, density: 1 });
  const inner = wkt.slice('POLYGON(('.length, -2);
  const pts = inner.split(',');
  assert.ok(pts.length > 3, `expected sampled curve, got ${pts.length} points`);
  assert.equal(pts[0], '0 0');
});

test('quadratic bezier path samples interior points', () => {
  const wkt = pathToWkt('M0 0 Q5 10 10 0', { flipY: false, density: 1 });
  assert.match(wkt, /^POLYGON\(\(0 0,/);
});

test('arc command is flattened to points', () => {
  const wkt = pathToWkt('M0 0 A5 5 0 0 1 10 0', { flipY: false, density: 1 });
  const inner = wkt.slice('POLYGON(('.length, -2);
  const pts = inner.split(',');
  assert.ok(pts.length > 3, `expected flattened arc, got ${pts.length} points`);
  // The arc endpoint should be reached.
  assert.equal(pts[pts.length - 2], '10 0');
});

test('implicit repeated lineto after moveto', () => {
  const wkt = pathToWkt('M0 0 10 0 10 10 Z', { flipY: false });
  assert.equal(wkt, 'POLYGON((0 0,10 0,10 10,0 0))');
});

test('multiple elements emitted in document order', () => {
  const svg =
    '<svg><line x1="0" y1="0" x2="1" y2="0"/><rect width="1" height="1"/></svg>';
  const wkt = svgToWkt(svg, { flipY: false });
  assert.equal(
    wkt,
    'GEOMETRYCOLLECTION(LINESTRING(0 0,1 0),POLYGON((0 0,1 0,1 1,0 1,0 0)))',
  );
});

test('comments, CDATA and unsupported elements are ignored', () => {
  const svg = `<svg>
    <!-- a comment with <rect/> inside -->
    <defs><style><![CDATA[ rect { fill: red } ]]></style></defs>
    <rect width="1" height="1"/>
  </svg>`;
  const wkt = svgToWkt(svg, { flipY: false });
  // only the one real rect is converted; comment/CDATA contents are skipped.
  assert.equal(wkt, 'GEOMETRYCOLLECTION(POLYGON((0 0,1 0,1 1,0 1,0 0)))');
});

test('transform on an element is applied (translate)', () => {
  const wkt = svgToWkt('<rect width="1" height="1" transform="translate(5 5)"/>', {
    flipY: false,
  });
  assert.equal(wkt, 'GEOMETRYCOLLECTION(POLYGON((5 5,6 5,6 6,5 6,5 5)))');
});

test('transform on an ancestor <g> is inherited and composed', () => {
  const svg =
    '<svg><g transform="translate(10 0)"><rect width="1" height="1" transform="scale(2)"/></g></svg>';
  const wkt = svgToWkt(svg, { flipY: false });
  // scale(2) then translate(10,0): (0,0)->(10,0), (1,1)->(12,2)
  assert.equal(wkt, 'GEOMETRYCOLLECTION(POLYGON((10 0,12 0,12 2,10 2,10 0)))');
});

test('nested groups compose; siblings unaffected after group closes', () => {
  const svg =
    '<svg>' +
    '<g transform="translate(100 100)"><rect width="1" height="1"/></g>' +
    '<rect width="1" height="1"/>' +
    '</svg>';
  const wkt = svgToWkt(svg, { flipY: false });
  assert.equal(
    wkt,
    'GEOMETRYCOLLECTION(' +
      'POLYGON((100 100,101 100,101 101,100 101,100 100)),' +
      'POLYGON((0 0,1 0,1 1,0 1,0 0)))',
  );
});

test('matrix() transform is applied to points', () => {
  // matrix(a b c d e f): x' = a*x + c*y + e, y' = b*x + d*y + f
  const wkt = svgToWkt('<line x1="1" y1="0" x2="0" y2="1" transform="matrix(2 0 0 3 1 1)"/>', {
    flipY: false,
  });
  assert.equal(wkt, 'GEOMETRYCOLLECTION(LINESTRING(3 1,1 4))');
});

test('rotate(90) transform (with Y flip) maps axes as expected', () => {
  // rotate 90deg: (1,0)->(0,1); default flipY negates Y => "0 -1"
  const wkt = svgToWkt('<line x1="1" y1="0" x2="1" y2="0" transform="rotate(90)"/>');
  assert.equal(wkt, 'GEOMETRYCOLLECTION(LINESTRING(0 -1,0 -1))');
});

test('rotate around a center point', () => {
  // rotate 180 about (5,5): (5,5)->(5,5), (6,5)->(4,5)
  const wkt = svgToWkt('<line x1="5" y1="5" x2="6" y2="5" transform="rotate(180 5 5)"/>', {
    flipY: false,
  });
  assert.equal(wkt, 'GEOMETRYCOLLECTION(LINESTRING(5 5,4 5))');
});

test('transform is applied to sampled curves (circle)', () => {
  const plain = svgToWkt('<circle cx="0" cy="0" r="5"/>', { density: 0.2, flipY: false });
  const shifted = svgToWkt(
    '<circle cx="0" cy="0" r="5" transform="translate(100 0)"/>',
    { density: 0.2, flipY: false },
  );
  const firstPlain = plain.match(/\(\(([^,]+),/)[1];
  const firstShifted = shifted.match(/\(\(([^,]+),/)[1];
  assert.equal(firstPlain, '5 0');
  assert.equal(firstShifted, '105 0');
});

test('attribute values containing ">" do not break the scanner', () => {
  const svg = '<rect width="2" height="2" data-note="a > b"/>';
  const wkt = svgToWkt(svg, { flipY: false });
  assert.equal(wkt, 'GEOMETRYCOLLECTION(POLYGON((0 0,2 0,2 2,0 2,0 0)))');
});

test('precision option rounds coordinates', () => {
  const wkt = pathToWkt('M0 0 L1.23456 0', { flipY: false, precision: 2 });
  assert.equal(wkt, 'POLYGON((0 0,1.23 0,0 0))');
});

test('empty / geometry-free SVG yields an empty collection', () => {
  assert.equal(svgToWkt('<svg></svg>'), 'GEOMETRYCOLLECTION()');
});

test('degenerate shapes are skipped', () => {
  assert.equal(
    svgToWkt('<svg><rect width="0" height="5"/><circle r="0"/></svg>'),
    'GEOMETRYCOLLECTION()',
  );
});

test('scientific notation and sign-glued numbers parse correctly', () => {
  const wkt = pathToWkt('M0 0L1e1 0L10-5', { flipY: false });
  assert.equal(wkt, 'POLYGON((0 0,10 0,10 -5,0 0))');
});

test('viewBox is ignored by default', () => {
  const svg = '<svg viewBox="0 0 100 100" width="500" height="500"><rect width="10" height="10"/></svg>';
  assert.equal(
    svgToWkt(svg, { flipY: false }),
    'GEOMETRYCOLLECTION(POLYGON((0 0,10 0,10 10,0 10,0 0)))',
  );
});

test('applyViewBox scales content to the viewport (uniform meet)', () => {
  const svg = '<svg viewBox="0 0 100 100" width="500" height="500"><rect width="10" height="10"/></svg>';
  assert.equal(
    svgToWkt(svg, { flipY: false, applyViewBox: true }),
    'GEOMETRYCOLLECTION(POLYGON((0 0,50 0,50 50,0 50,0 0)))',
  );
});

test('viewport option implies applyViewBox and overrides width/height', () => {
  const svg = '<svg viewBox="0 0 100 100"><rect width="10" height="10"/></svg>';
  assert.equal(
    svgToWkt(svg, { flipY: false, viewport: { width: 200, height: 200 } }),
    'GEOMETRYCOLLECTION(POLYGON((0 0,20 0,20 20,0 20,0 0)))',
  );
});

test('viewBox without a viewport applies offset only (scale 1)', () => {
  const svg = '<svg viewBox="10 20 100 100"><rect x="10" y="20" width="5" height="5"/></svg>';
  assert.equal(
    svgToWkt(svg, { flipY: false, applyViewBox: true }),
    'GEOMETRYCOLLECTION(POLYGON((0 0,5 0,5 5,0 5,0 0)))',
  );
});

test('preserveAspectRatio="none" allows non-uniform scaling', () => {
  const svg =
    '<svg viewBox="0 0 100 50" width="100" height="100" preserveAspectRatio="none"><rect width="100" height="50"/></svg>';
  assert.equal(
    svgToWkt(svg, { flipY: false, applyViewBox: true }),
    'GEOMETRYCOLLECTION(POLYGON((0 0,100 0,100 100,0 100,0 0)))',
  );
});

test('meet uses min scale and centers (xMidYMid)', () => {
  const svg = '<svg viewBox="0 0 100 100" width="200" height="100"><rect width="10" height="10"/></svg>';
  assert.equal(
    svgToWkt(svg, { flipY: false, applyViewBox: true }),
    'GEOMETRYCOLLECTION(POLYGON((50 0,60 0,60 10,50 10,50 0)))',
  );
});

test('slice uses max scale and centers (xMidYMid)', () => {
  const svg =
    '<svg viewBox="0 0 100 100" width="200" height="100" preserveAspectRatio="xMidYMid slice"><rect width="10" height="10"/></svg>';
  assert.equal(
    svgToWkt(svg, { flipY: false, applyViewBox: true }),
    'GEOMETRYCOLLECTION(POLYGON((0 -50,20 -50,20 -30,0 -30,0 -50)))',
  );
});

test('viewBox composes with transforms and Y flip', () => {
  // scale x2 from viewBox, then translate(5,0) on the rect, then flip Y.
  const svg =
    '<svg viewBox="0 0 100 100" width="200" height="200"><rect width="10" height="10" transform="translate(5 0)"/></svg>';
  assert.equal(
    svgToWkt(svg, { applyViewBox: true }),
    // (5,0)->(10,0); (15,10)->(30,20); flipY => negate y
    'GEOMETRYCOLLECTION(POLYGON((10 0,30 0,30 -20,10 -20,10 0)))',
  );
});

test('no negative zero in output', () => {
  const wkt = svgToWkt('<rect x="0" y="0" width="1" height="1"/>'); // flips y
  assert.ok(!wkt.includes('-0 '), wkt);
  assert.ok(!wkt.includes(' -0,') && !wkt.includes(' -0)'), wkt);
});
