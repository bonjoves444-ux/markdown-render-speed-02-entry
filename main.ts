import { readFile } from 'node:fs/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR || '/input';
const input = JSON.parse(await readFile(`${inputDir}/cases.json`, 'utf8'));
const outDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';
await mkdir(outDir, { recursive: true });
const cases = Array.isArray(input) ? input : input.cases;
// Preserve input order; each parse call owns its document state.
const html = cases.map((item: any) => parse(typeof item === 'string' ? item : item.markdown));
await writeFile(`${outDir}/html.json`, JSON.stringify(html));
