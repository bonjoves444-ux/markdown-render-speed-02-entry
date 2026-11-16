// Driver for the markdown renderer: reads every case from the
// input directory, renders each one on its own with parse(), and
// writes the HTML strings out in the cases' order.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as {
  id: string;
  markdown: string;
}[];

const html: string[] = [];
for (const c of cases) html.push(parse(c.markdown));

// The output directory is a mount point in the harness: create it
// only when it is missing, never remove or recreate it.
mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(join(OUTPUT_DIR, 'html.json'), JSON.stringify(html));
