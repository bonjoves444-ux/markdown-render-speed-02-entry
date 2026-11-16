// main.ts — the program the harness runs (node /bot/main.ts, node 22).
// It reads every case from /input/cases.json (or $MAKEFUN_INPUT_DIR), renders
// each one alone with parse() from parse.js, and writes /output/html.json
// (or $MAKEFUN_OUTPUT_DIR): a JSON array of the HTML strings, one per case
// and in the cases' order.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Each case is rendered alone: parse() keeps nothing from an earlier call,
// so rendering order cannot change any output.
const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; markdown: string }[];
const html: string[] = [];
for (const c of cases) html.push(parse(c.markdown));
writeFileSync(join(OUTPUT_DIR, 'html.json'), JSON.stringify(html));
