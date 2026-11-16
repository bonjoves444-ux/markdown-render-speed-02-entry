// The driver the harness runs: node main.ts reads every case from the input
// directory, renders each one on its own with parse(), and writes the HTML
// strings, in order, to the output directory as html.json.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Each case is rendered on its own: parse() holds no state between calls,
// so the order and the count of cases cannot change any output.
const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));
const html = new Array(cases.length);
for (let k = 0; k < cases.length; k++) {
  html[k] = parse(cases[k].markdown);
}
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
