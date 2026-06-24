// Vendor the UMD bundle into the GitHub Pages demo so the page is fully static
// and needs no build step or CDN to run.
import { copyFileSync, mkdirSync } from 'node:fs';

mkdirSync(new URL('../docs/', import.meta.url), { recursive: true });
copyFileSync(
  new URL('../dist/umd/svg2wkt.js', import.meta.url),
  new URL('../docs/svg2wkt.js', import.meta.url),
);

console.log('copied UMD bundle to docs/svg2wkt.js');
