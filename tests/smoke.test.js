/**
 * Basic smoke tests for AI Metadata Suggester.
 * Run with: node --test tests/
 */

const { describe, it } = require("node:test");
const assert = require("node:assert");

describe("plugin smoke tests", () => {
  it("manifest.json is valid JSON with required fields", () => {
    const fs = require("fs");
    const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
    assert.strictEqual(typeof manifest.id, "string");
    assert.strictEqual(typeof manifest.name, "string");
    assert.strictEqual(typeof manifest.version, "string");
    assert.ok(manifest.minAppVersion);
    assert.ok(manifest.description);
  });

  it("main.ts exists and contains the plugin class", () => {
    const fs = require("fs");
    const src = fs.readFileSync("main.ts", "utf8");
    assert.ok(src.includes("export default class AIMetadataSuggester"));
    assert.ok(src.includes("suggestForFile"));
    assert.ok(src.includes("processFrontMatter"));
  });

  it("styles.css exists", () => {
    const fs = require("fs");
    assert.ok(fs.existsSync("styles.css"));
  });
});
