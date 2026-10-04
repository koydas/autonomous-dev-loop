// Tests for the expanded validation dataset handling
import { parseDataset } from "../evals/datasets/validation.js";
import fs from "fs";
import path from "path";

describe("parseDataset with new tags", () => {
  const datasetPath = path.resolve(__dirname, "../evals/datasets/validation.jsonl");
  const rawData = fs.readFileSync(datasetPath, "utf-8");
  const cases = rawData
    .split(/\n/)
    .filter((line) => line.trim() && !line.trim().startsWith("#"))
    .map((line) => JSON.parse(line));

  test("should parse all cases without error", () => {
    expect(() => parseDataset(cases)).not.toThrow();
  });

  test("should include new tags in parsed output", () => {
    const parsed = parseDataset(cases);
    const tags = new Set();
    parsed.forEach((c) => {
      if (c.tags) {
        c.tags.forEach((t) => tags.add(t));
      }
    });
    // New tags introduced in this PR
    const newTags = [
      "partial-ac",
      "role-scope",
      "stub",
      "short",
      "fr",
      "warnings-only",
    ];
    newTags.forEach((t) => {
      expect(tags.has(t)).toBe(true);
    });
  });

  test("should correctly count valid and invalid cases", () => {
    const parsed = parseDataset(cases);
    const validCount = parsed.filter((c) => c.valid).length;
    const invalidCount = parsed.filter((c) => !c.valid).length;
    expect(validCount).toBe(12);
    expect(invalidCount).toBe(18);
  });
});
