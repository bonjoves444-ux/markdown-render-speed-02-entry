// Entry point: render each case in cases.json to html.json.
// Input and output directories come from the environment so the
// same program works both locally and on the grading server.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { parse } from "./parse.js";

const inputDir = process.env.MAKEFUN_INPUT_DIR || "/input";
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";

const cases = JSON.parse(readFileSync(`${inputDir}/cases.json`, "utf8"));
const html = cases.map((c) => parse(c.markdown));

mkdirSync(outputDir, { recursive: true });
writeFileSync(`${outputDir}/html.json`, JSON.stringify(html));
