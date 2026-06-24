# svg2wkt

Convert an SVG string into a [WKT](https://en.wikipedia.org/wiki/Well-known_text_representation_of_geometry)
(Well-Known Text) geometry string.

- **Zero runtime dependencies** — no DOM, no bezier library. SVG parsing, path
  sampling and arc flattening are all implemented from scratch.
- **TypeScript** — ships type declarations.
- **Universal** — ESM, CommonJS and a UMD build for direct use from a CDN.
- Runs in Node, browsers, Deno and bundlers.

Inspired by David McClure's [`svg-to-wkt`](https://github.com/davidmcclure/svg-to-wkt),
rebuilt in modern TypeScript with no dependencies.

## Install

```sh
npm install svg2wkt
```

## Usage

### ESM / TypeScript

```ts
import { svgToWkt } from 'svg2wkt';

svgToWkt('<svg><rect width="2" height="2"/></svg>');
// 'GEOMETRYCOLLECTION(POLYGON((0 0,2 0,2 -2,0 -2,0 0)))'
```

### CommonJS

```js
const { svgToWkt } = require('svg2wkt');
```

### Browser via CDN (UMD)

```html
<script src="https://unpkg.com/svg2wkt"></script>
<script>
  // exposed as a global `svg2wkt`
  console.log(svg2wkt.svgToWkt('<circle cx="0" cy="0" r="10"/>'));
</script>
```

## API

### `svgToWkt(svg, options?) => string`

Converts an SVG string into a WKT `GEOMETRYCOLLECTION`. Supported elements are
converted in document order; everything else is ignored.

| Element     | WKT output    |
| ----------- | ------------- |
| `<line>`    | `LINESTRING`  |
| `<polyline>`| `LINESTRING`  |
| `<polygon>` | `POLYGON`     |
| `<rect>`    | `POLYGON`     |
| `<circle>`  | `POLYGON` (approximated) |
| `<ellipse>` | `POLYGON` (approximated) |
| `<path>`    | `POLYGON` (curves sampled, subpaths become rings) |

### `pathToWkt(d, options?) => string`

Converts a single SVG path `d` attribute into a WKT `POLYGON`. Each subpath
becomes a ring (the first is the exterior, subsequent ones are treated as
holes). Returns `''` if the path produces no geometry.

```ts
import { pathToWkt } from 'svg2wkt';

pathToWkt('M0 0 H10 V10 H0 Z', { flipY: false });
// 'POLYGON((0 0,10 0,10 10,0 10,0 0))'
```

### Options

| Option      | Type      | Default | Description |
| ----------- | --------- | ------- | ----------- |
| `flipY`        | `boolean` | `true`  | Negate the Y axis. SVG's Y axis points down; WKT geometry is conventionally Y-up, so flipping is usually desired. Set to `false` to keep coordinates exactly as in the SVG. |
| `precision`    | `number`  | `3`     | Number of decimal places kept in output coordinates. |
| `density`      | `number`  | `1`     | Sampling density for curved geometry (circles, ellipses, path curves), in sample points per unit of length. Higher = smoother and more vertices. |
| `applyViewBox` | `boolean` | `false` | Apply the `<svg>` `viewBox` → viewport mapping so output is in rendered/pixel space instead of raw content units (see below). |
| `viewport`     | `{ width, height }` | — | Explicit viewport size (px) for the root `<svg>`, overriding its `width`/`height`. Setting this implies `applyViewBox: true`. |

## Path commands

All SVG path commands are supported, in both absolute and relative form:
`M`/`m`, `L`/`l`, `H`/`h`, `V`/`v`, `C`/`c`, `S`/`s`, `Q`/`q`, `T`/`t`,
`A`/`a` and `Z`/`z`. Cubic and quadratic béziers are flattened by adaptive
sampling, and elliptical arcs are flattened via the endpoint-to-center
parameterization from the SVG spec.

## Transforms

`transform` attributes are fully supported, including all SVG transform
functions — `matrix`, `translate`, `scale`, `rotate` (with optional center),
`skewX` and `skewY`. Transforms on ancestor `<g>`/`<svg>` elements are
inherited and composed with an element's own transform, so nested groups behave
as expected.

```ts
svgToWkt('<g transform="translate(10 0)"><rect width="1" height="1" transform="scale(2)"/></g>', {
  flipY: false,
});
// 'GEOMETRYCOLLECTION(POLYGON((10 0,12 0,12 2,10 2,10 0)))'
```

> Note: `pathToWkt(d)` operates on a bare path string and therefore applies no
> transform; use `svgToWkt` for transform-aware conversion.

## viewBox

By default, output coordinates are in the SVG's **content coordinate system**
(the numbers as authored). Set `applyViewBox: true` to instead map content
through the `<svg>` `viewBox` → viewport transform, producing **rendered/pixel
space** coordinates:

```ts
const svg = '<svg viewBox="0 0 100 100" width="500" height="500"><rect width="10" height="10"/></svg>';

svgToWkt(svg, { flipY: false });
// 'GEOMETRYCOLLECTION(POLYGON((0 0,10 0,10 10,0 10,0 0)))'         // content units

svgToWkt(svg, { flipY: false, applyViewBox: true });
// 'GEOMETRYCOLLECTION(POLYGON((0 0,50 0,50 50,0 50,0 0)))'         // scaled x5 to viewport
```

- `preserveAspectRatio` is honored, including `none` (non-uniform scale),
  `meet`/`slice`, and `xMin/xMid/xMax` + `YMin/YMid/YMax` alignment.
- For viewBox-only SVGs with no intrinsic size, pass `viewport: { width, height }`
  (which also enables `applyViewBox`). With no resolvable viewport at all, the
  mapping falls back to scale 1, applying only the viewBox `min-x`/`min-y` offset.
- Nested `<svg>` elements with their own `viewBox` are handled too.
- viewBox composes with `transform` attributes and the `flipY` option.

## Notes & limitations

- **Rounded `<rect>` corners (`rx`/`ry`) are ignored** — rectangles are emitted
  as their four corners.
- **`width`/`height` units:** only unitless and `px` values are resolved for the
  viewport; `%`, `em`, `in`, etc. fall back to the offset-only mapping above.
- A `<path>` always becomes a `POLYGON` (closed). Compound paths map each
  subpath to a ring, which models holes (e.g. the letter "O") well, but does not
  attempt to split disjoint subpaths into a `MULTIPOLYGON`.
- Degenerate shapes (zero radius/size, too few points) are skipped.

## Demo

An interactive demo lives in [`docs/`](./docs): it converts a default SVG, lets
you edit the source or **drag & drop your own `.svg` file**, tweak options live,
and renders the resulting WKT geometry next to the original so you can compare
them.

Run it locally:

```sh
npm run build            # also vendors the UMD bundle into docs/svg2wkt.js
# then serve the folder, e.g.
npx --yes serve docs     # or: python3 -m http.server -d docs
```

### Publishing on GitHub Pages

A workflow at [`.github/workflows/deploy-pages.yml`](./.github/workflows/deploy-pages.yml)
builds the library, vendors the UMD bundle into `docs/`, runs the tests, and
deploys `docs/` to GitHub Pages on every push to `main` (and on manual
dispatch). One-time setup: in *Settings → Pages*, set **Source** to
**GitHub Actions**.

Because CI rebuilds it, the generated `docs/svg2wkt.js` is git-ignored and does
not need to be committed.

## Development

```sh
npm run build   # emit dist/esm, dist/cjs and dist/umd
npm test        # build, then run the test suite (Node's built-in runner)
```

The build uses only `tsc`; the UMD bundle is produced by a small Node script
that wraps the compiled output. There are no third-party runtime or build
dependencies.

## License

MIT
