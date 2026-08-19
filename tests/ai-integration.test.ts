import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { callAI, embedTexts, fetchAvailableModels, testAIConnection } from "../src/ai";
import { estimateTokens, splitText } from "../src/paper";
import { filePickerPath } from "../src/paths";
import {
  buildVectorIndex,
  cosineScores,
  getVectorIndexStatus,
  loadVectorIndex,
} from "../src/vector-index";

test("runs model discovery, chat, embeddings and compact vector cache end to end", async () => {
  const server = createServer((request, response) => {
    if (request.headers.authorization && request.headers.authorization !== "Bearer valid-key") {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "invalid key" } }));
      return;
    }
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          data: [{ id: "paper-chat" }, { id: "text-embedding-3-small" }],
        }),
      );
      return;
    }
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const payload = JSON.parse(body) as {
          model?: string;
          messages?: Array<{ content?: string }>;
          max_tokens?: number;
          thinking?: { type?: string };
        };
        assert.equal(payload.model, "paper-chat");
        assert.ok(payload.messages?.length);
        if (payload.messages?.some((message) => message.content === "Connection check")) {
          assert.equal(payload.thinking?.type, "disabled");
          assert.equal(payload.max_tokens, 64);
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  reasoning_content: "private reasoning",
                  content: "<think>also private</think>\n正常显示的回答",
                },
              },
            ],
          }),
        );
      });
      return;
    }
    if (request.method === "POST" && request.url === "/v1/embeddings") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const payload = JSON.parse(body) as { input?: string[] };
        const inputs = payload.input ?? [];
        if (inputs.length > 4 || inputs.some((value) => value.length > 160)) {
          response.writeHead(400, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ message: "batch token limit exceeded" }));
          return;
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            data: inputs.map((value, index) => ({
              index,
              embedding: [value.length + 1, (value.match(/paper/gi) ?? []).length + 1, 1],
            })),
          }),
        );
      });
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: "not found" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/v1`;
  const testRoot = join(tmpdir(), `paper-companion-test-${Date.now()}`);
  const preferences: Record<string, unknown> = {
    "papercompanion.storageDirectory": testRoot,
  };

  (globalThis as unknown as { PathUtils: unknown }).PathUtils = { join };
  (globalThis as unknown as { IOUtils: unknown }).IOUtils = {
    exists: async (path: string) =>
      readFile(path)
        .then(() => true)
        .catch(() => false),
    read: async (path: string) => new Uint8Array(await readFile(path)),
    write: async (path: string, data: Uint8Array) => {
      await writeFile(path, data);
      return data.byteLength;
    },
    remove: async (path: string) => rm(path, { force: true }),
  };
  const http = {
    async request(this: unknown, method: string, url: string, options: Record<string, unknown>) {
      // Zotero's implementation requires its method receiver. This assertion
      // prevents requestJSON from accidentally detaching HTTP.request again.
      assert.equal(this, http);
      const result = await fetch(url, {
        method,
        headers: options.headers as HeadersInit,
        body: options.body as string | undefined,
      });
      const responseText = await result.text();
      if (!result.ok) throw { status: result.status, responseText };
      return { status: result.status, responseText };
    },
  };
  (globalThis as unknown as { Zotero: unknown }).Zotero = {
    Prefs: { get: (key: string) => preferences[key] },
    getProfileDirectory: () => ({ path: testRoot }),
    Utilities: {
      Internal: {
        md5: (value: string) => createHash("md5").update(value).digest("hex"),
      },
    },
    File: {
      createDirectoryIfMissingAsync: (path: string) => mkdir(path, { recursive: true }),
      putContentsAsync: (path: string, value: string) => writeFile(path, value, "utf8"),
      getContentsAsync: (path: string) => readFile(path, "utf8"),
    },
    logError: () => undefined,
    HTTP: http,
  };

  try {
    assert.equal(filePickerPath("C:\\Paper Companion"), "C:\\Paper Companion");
    assert.equal(filePickerPath({ path: "D:\\Notes" }), "D:\\Notes");
    assert.throws(() => filePickerPath(undefined), /没有返回有效路径/);

    const connection = {
      provider: "custom" as const,
      apiBase: base,
      apiKey: "valid-key",
      model: "paper-chat",
    };
    const models = await fetchAvailableModels({ ...connection, model: "" });
    assert.deepEqual(
      models.map((model) => model.id),
      ["paper-chat"],
    );
    const embeddingModels = await fetchAvailableModels({ ...connection, model: "" }, "embedding");
    assert.deepEqual(
      embeddingModels.map((model) => model.id),
      ["text-embedding-3-small"],
    );
    const ollamaEmbeddingModels = await fetchAvailableModels(
      {
        ...connection,
        provider: "ollama",
        apiKey: "",
        model: "",
      },
      "embedding",
    );
    assert.deepEqual(
      ollamaEmbeddingModels.map((model) => model.id),
      ["text-embedding-3-small"],
    );

    const answer = await callAI([{ role: "user", content: "test" }], {}, connection);
    assert.equal(answer, "正常显示的回答");
    await testAIConnection({
      ...connection,
      provider: "deepseek",
    });
    const embeddingConnection = { ...connection, model: "text-embedding-3-small" };
    const embeddings = await embedTexts(["paper alpha", "beta"], embeddingConnection);
    assert.equal(embeddings.length, 2);
    assert.equal(embeddings[0]?.length, 3);
    const bulkEmbeddings = await embedTexts(
      Array.from({ length: 10 }, (_, index) => `paper embedding ${index}`),
      embeddingConnection,
    );
    assert.equal(bulkEmbeddings.length, 10);
    const adaptivelySplitEmbedding = await embedTexts(
      ["paper equation token ".repeat(30)],
      embeddingConnection,
    );
    assert.equal(adaptivelySplitEmbedding.length, 1);
    assert.equal(adaptivelySplitEmbedding[0]?.length, 3);

    const tokenAwareChunks = splitText(
      `${"Academic evidence and experimental result. ".repeat(700)}${"中文方法与研究结果。".repeat(700)}`,
    );
    assert.ok(tokenAwareChunks.length > 10);
    assert.ok(tokenAwareChunks.every((chunk) => estimateTokens(chunk.text) <= 420));

    const structureAwareChunks = splitText(
      "Paper title\r\nFirst paragraph\fSecond page\n\nEquation and conclusion",
    );
    assert.equal(structureAwareChunks.length, 1);
    assert.match(
      structureAwareChunks[0]?.text ?? "",
      /Paper title\nFirst paragraph\n\nSecond page\n\nEquation and conclusion/,
    );

    const metadata = {
      libraryID: 1,
      itemID: 2,
      itemKey: "ITEM",
      attachmentID: 3,
      attachmentKey: "PDF",
      title: "Test paper",
      authors: [],
      year: "",
      publication: "",
      doi: "",
      abstract: "",
    };
    const chunks = [
      { id: 1, text: "paper alpha", start: 0, end: 11 },
      { id: 2, text: "beta", start: 8, end: 12 },
    ];
    const index = await buildVectorIndex(metadata, chunks, "content-hash", embeddingConnection);
    const loaded = await loadVectorIndex(
      metadata,
      "content-hash",
      chunks.length,
      embeddingConnection,
    );
    assert.ok(loaded);
    assert.equal(loaded.dimensions, 3);
    assert.equal(cosineScores(index, embeddings[0] ?? []).length, 2);
    const restoredStatus = await getVectorIndexStatus(
      metadata,
      "content-hash",
      embeddingConnection,
    );
    assert.equal(restoredStatus?.chunkCount, chunks.length);

    await assert.rejects(
      fetchAvailableModels({ ...connection, apiKey: "bad-key", model: "" }),
      /认证失败.*401/,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(testRoot, { recursive: true, force: true });
  }
});

