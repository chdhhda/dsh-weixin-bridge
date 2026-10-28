import assert from "node:assert/strict";
import test from "node:test";

import { extractText, parseLossless } from "../lib/api.mjs";
import { chunkText, convertTables, forWeChat } from "../index.js";

test("parseLossless keeps uint64 ids exact", () => {
  const out = parseLossless('{"message_id":7521097456011258760,"ret":0}');
  assert.equal(out.message_id, "7521097456011258760");
  assert.equal(out.ret, 0, "non-id fields stay numbers");
});

test("parseLossless handles every id field and nesting", () => {
  const out = parseLossless('{"msgs":[{"msg_id":1,"svr_id":9007199254740993}],"message_id":42}');
  assert.equal(out.msgs[0].msg_id, "1");
  assert.equal(out.msgs[0].svr_id, "9007199254740993");
  assert.equal(out.message_id, "42");
});

test("parseLossless tolerates whitespace around the colon", () => {
  assert.equal(parseLossless('{"message_id" :\n 123}').message_id, "123");
});

test("parseLossless never rewrites text inside strings", () => {
  const raw = '{"text":"say \\"message_id\\": 123 ok"}';
  assert.equal(parseLossless(raw).text, 'say "message_id": 123 ok');
});

test("parseLossless leaves array elements and unknown keys alone", () => {
  const out = parseLossless('{"nums":[123,456],"other":789}');
  assert.deepEqual(out.nums, [123, 456]);
  assert.equal(out.other, 789);
});

test("parseLossless quotes negative ids", () => {
  assert.equal(parseLossless('{"message_id":-5}').message_id, "-5");
});

test("extractText reads plain text", () => {
  assert.equal(extractText({ item_list: [{ type: 1, text_item: { text: "你好" } }] }), "你好");
});

test("extractText falls back to voice transcription", () => {
  assert.equal(extractText({ item_list: [{ type: 3, voice_item: { text: "转录内容" } }] }), "转录内容");
});

test("extractText joins several items with newlines", () => {
  const msg = {
    item_list: [
      { type: 1, text_item: { text: "第一行" } },
      { type: 1, text_item: { text: "第二行" } },
    ],
  };
  assert.equal(extractText(msg), "第一行\n第二行");
});

test("extractText summarises media items", () => {
  assert.equal(extractText({ item_list: [{ type: 2 }] }), "[图片]");
  assert.equal(extractText({ item_list: [{ type: 4, file_item: { file_name: "a.pdf" } }] }), "[文件 a.pdf]");
  assert.equal(extractText({ item_list: [{ type: 4 }] }), "[文件 ]");
  assert.equal(extractText({ item_list: [{ type: 5 }] }), "[视频]");
});

test("extractText returns empty for empty or malformed messages", () => {
  assert.equal(extractText({}), "");
  assert.equal(extractText({ item_list: [] }), "");
  assert.equal(extractText(undefined), "");
  assert.equal(extractText({ item_list: [{ type: 1 }] }), "");
});

test("chunkText leaves short text alone", () => {
  assert.deepEqual(chunkText("短消息", 100), ["短消息"]);
  assert.deepEqual(chunkText("   ", 100), []);
});

test("chunkText respects the limit and loses no content", () => {
  const paragraph = "这是一段用于测试分片的中文文本，长度适中，重复若干次以超过上限。";
  const text = Array.from({ length: 12 }, () => paragraph).join("\n\n");
  const chunks = chunkText(text, 200);
  assert.ok(chunks.length > 1, "long text must be split");
  for (const chunk of chunks) assert.ok(chunk.length <= 200, `chunk too long: ${chunk.length}`);
  const squash = (s) => s.replace(/\s+/g, "");
  assert.equal(chunks.map(squash).join(""), squash(text));
});

test("chunkText cuts mid-word when no boundary exists", () => {
  const text = "x".repeat(500);
  const chunks = chunkText(text, 120);
  assert.equal(chunks.length, 5);
  for (const chunk of chunks) assert.ok(chunk.length <= 120);
});

test("forWeChat strips fences but keeps code", () => {
  assert.equal(forWeChat("```js\nconst a = 1;\n```"), "const a = 1;");
});

test("forWeChat unwraps inline code, links, bold, headings, bullets", () => {
  assert.equal(forWeChat("`npm i`"), "npm i");
  assert.equal(forWeChat("[百度](https://a.com)"), "百度 (https://a.com)");
  assert.equal(forWeChat("**粗体**"), "粗体");
  assert.equal(forWeChat("### 标题"), "标题");
  assert.equal(forWeChat("- 一\n- 二"), "· 一\n· 二");
});

test("forWeChat turns an image link into its url", () => {
  assert.equal(forWeChat("![图](https://a.com/x.png)"), "https://a.com/x.png");
});

test("convertTables turns a key/value table into plain lines", () => {
  const table = ["| 项目 | 位置 |", "|---|---|", "| 工作目录 | /opt/workspace |", "| 机器 | PC-1 |"].join("\n");
  assert.equal(convertTables(table), "工作目录: /opt/workspace\n机器: PC-1");
});

test("convertTables handles three columns and surrounding prose", () => {
  const text = ["说明：", "| a | b | c |", "|:--|--:|:-:|", "| 1 | 2 | 3 |", "结束"].join("\n");
  assert.equal(convertTables(text), "说明：\n1 · 2 · 3\n结束");
});

test("convertTables leaves non-table pipes alone", () => {
  const text = "用 a | b 表示或";
  assert.equal(convertTables(text), text);
});

test("forWeChat never leaves a raw table behind", () => {
  const out = forWeChat("| k | v |\n|---|---|\n| 甲 | 乙 |");
  assert.ok(!out.includes("|"), `still has pipes: ${out}`);
});

