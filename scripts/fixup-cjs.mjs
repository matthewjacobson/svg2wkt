// Mark the CJS output directory as CommonJS so Node doesn't interpret the
// .js files there as ESM (the root package.json sets "type": "module").
import { writeFileSync } from 'node:fs';

writeFileSync(
  new URL('../dist/cjs/package.json', import.meta.url),
  JSON.stringify({ type: 'commonjs' }, null, 2) + '\n',
);

console.log('wrote dist/cjs/package.json');
