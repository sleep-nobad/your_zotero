import assert from "node:assert/strict";
import test from "node:test";

import {
  endpoint,
  extractAssistantText,
  isLikelyChatModel,
  isLikelyEmbeddingModel,
  modelCatalogFromJSON,
  parseModelCatalog,
} from "../src/ai-core.ts";

test("builds compatible model and chat endpoints", () => {
  assert.equal(
    endpoint("https://api.openai.com/v1/", "models"),
    "https://api.openai.com/v1/models",
  );
  assert.equal(
    endpoint("https://example.test/v1/chat/completions", "models"),
    "https://example.test/v1/models",
  );
  assert.equal(
    endpoint("https://api.deepseek.com", "chat/completions"),
    "https://api.deepseek.com/chat/completions",
  );
});

test("parses, de-duplicates and sorts account models", () => {
  const models = parseModelCatalog({
    data: [{ id: "z-model" }, { id: "a-model", name: "A" }, { id: "a-model" }, null],
  });
  assert.deepEqual(models, [
    { id: "a-model", name: "A" },
    { id: "z-model", name: undefined },
  ]);
  assert.deepEqual(modelCatalogFromJSON(JSON.stringify(models)), models);
});

test("filters non-chat model families", () => {
  assert.equal(isLikelyChatModel({ id: "deepseek-chat" }), true);
  assert.equal(isLikelyChatModel({ id: "text-embedding-3-small" }), false);
  assert.equal(isLikelyChatModel({ id: "gpt-image-1" }), false);
  assert.equal(isLikelyEmbeddingModel({ id: "text-embedding-3-small" }), true);
  assert.equal(isLikelyEmbeddingModel({ id: "deepseek-chat" }), false);
});

test("extracts visible answers and suppresses model reasoning", () => {
  assert.equal(
    extractAssistantText({
      choices: [{ message: { reasoning_content: "hidden", content: "final answer" } }],
    }),
    "final answer",
  );
  assert.equal(
    extractAssistantText({
      choices: [{ message: { content: "<think>private chain</think>\n公开答案" } }],
    }),
    "公开答案",
  );
  assert.equal(
    extractAssistantText({
      choices: [{ message: { content: [{ text: "part 1" }, { text: " + 2" }] } }],
    }),
    "part 1 + 2",
  );
});

test("rejects responses without a final answer", () => {
  assert.throws(
    () =>
      extractAssistantText({
        choices: [{ message: { content: "<think>only reasoning</think>" } }],
      }),
    /没有生成最终答案/,
  );
});
