import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { parse } from "./parse.js";

// The harness runs this program with $MAKEFUN_INPUT_DIR pointing at a
// directory holding cases.json ([{ id, markdown }, ...]) and
// $MAKEFUN_OUTPUT_DIR pointing at the directory where html.json (a JSON
// array of HTML strings, in case order) must land. The output directory
// is a mount point on the server: create it if missing, never remove it.
const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

const cases = JSON.parse(readFileSync(`${inputDir}/cases.json`, "utf8"));
const html = cases.map((c: { markdown?: string } | string) =>
  parse(typeof c === "string" ? c : (c.markdown ?? ""))
);

mkdirSync(outputDir, { recursive: true });
writeFileSync(`${outputDir}/html.json`, JSON.stringify(html));
