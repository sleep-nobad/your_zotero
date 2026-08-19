import assert from "node:assert/strict";
import test from "node:test";

import { renderMarkdown } from "../src/markdown.ts";

test("renders inline and display LaTeX as native MathML", () => {
  const html = renderMarkdown(
    "IoU thresholds \\(t_{pos}\\) and $t_{neg}$ are used.\n\n$$\\frac{a}{b}$$",
  );
  assert.match(html, /<math/);
  assert.match(html, /<msub>/);
  assert.match(html, /<mfrac>/);
  assert.doesNotMatch(html, /\\\(t_/);
});

test("keeps LaTeX-looking text literal inside code", () => {
  const html = renderMarkdown("`\\(t_{pos}\\)`\n```\n$not_math$\n```");
  assert.match(html, /<code>\\\(t_\{pos\}\\\)<\/code>/);
  assert.match(html, /\$not_math\$/);
});
