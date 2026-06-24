// Build a single-file UMD bundle for direct <script> / CDN use, with zero
// third-party tooling. The library is dependency-free and compiles to a single
// CommonJS file, so wrapping that file's body in a UMD shell is sufficient.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const cjs = readFileSync(new URL('../dist/cjs/index.js', import.meta.url), 'utf8');

const banner = '/*! svg2wkt | MIT License | https://www.npmjs.com/package/svg2wkt */';

const umd = `${banner}
(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define(['exports'], factory);
  } else if (typeof exports === 'object' && typeof module !== 'undefined') {
    factory(exports);
  } else {
    factory((root.svg2wkt = {}));
  }
})(
  typeof self !== 'undefined'
    ? self
    : typeof globalThis !== 'undefined'
    ? globalThis
    : this,
  function (exports) {
${cjs}
  }
);
`;

mkdirSync(new URL('../dist/umd/', import.meta.url), { recursive: true });
writeFileSync(new URL('../dist/umd/svg2wkt.js', import.meta.url), umd);

console.log('wrote dist/umd/svg2wkt.js');
