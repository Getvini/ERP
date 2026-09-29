import test from "node:test";
import assert from "node:assert/strict";
import {
    ScanScopeError,
    normalizeRegions,
    normalizeScenarioIds,
    parseIdList,
    qcItemInScope,
    regionBlockId,
    sheetsOfScope,
    spellItemInScope,
    stableItemId,
    upsertRegions
} from "./ScanScope.helper";

const region = (overrides: Record<string, unknown> = {}) => ({
    id: "r1",
    sheet: "S",
    label: "Ghi chú",
    startRow: 2,
    endRow: 5,
    startCol: 2,
    endCol: 4,
    ...overrides
});

test("normalizeRegions accepts valid regions and fills defaults", () => {
    const [result] = normalizeRegions([region({ label: "  A  " })], ["S"]);
    assert.equal(result.label, "A");
    assert.equal(result.qc, true);
    assert.equal(regionBlockId(result), "S::CUSTOM:r1");
});

test("normalizeRegions parses JSON strings and treats empty input as none", () => {
    assert.equal(normalizeRegions(JSON.stringify([region()]), ["S"]).length, 1);
    assert.deepEqual(normalizeRegions(undefined, ["S"]), []);
    assert.deepEqual(normalizeRegions("", ["S"]), []);
});

test("normalizeRegions keeps qc=false", () => {
    assert.equal(normalizeRegions([region({ qc: false })], ["S"])[0].qc, false);
});

test("normalizeRegions rejects invalid input", () => {
    const invalid: unknown[] = [
        "not json",
        {},
        [region({ id: "bad id" })],
        [region({ sheet: "Other" })],
        [region({ startRow: 0 })],
        [region({ startRow: 6, endRow: 5 })],
        [region({ startCol: 5, endCol: 4 })],
        [region({ endRow: 2000000 })],
        [region({ startRow: 1.5 })],
        [region(), region()]
    ];
    for (const input of invalid) {
        assert.throws(() => normalizeRegions(input, ["S"]), ScanScopeError);
    }
});

test("normalizeRegions caps the number of regions", () => {
    const many = Array.from({ length: 51 }, (_, i) => region({ id: `r${i}` }));
    assert.throws(() => normalizeRegions(many, ["S"]), ScanScopeError);
});

test("normalizeScenarioIds keeps undefined, dedupes and validates sheet prefix", () => {
    assert.equal(normalizeScenarioIds(undefined, ["S"]), undefined);
    assert.deepEqual(normalizeScenarioIds([], ["S"]), []);
    assert.deepEqual(normalizeScenarioIds(["S::R1C0", "S::R1C0"], ["S"]), ["S::R1C0"]);
    assert.throws(() => normalizeScenarioIds(["T::R1C0"], ["S"]), ScanScopeError);
});

test("parseIdList distinguishes missing from empty", () => {
    assert.equal(parseIdList(undefined), undefined);
    assert.deepEqual(parseIdList(""), []);
    assert.deepEqual(parseIdList("a, b,,c"), ["a", "b", "c"]);
});

test("sheetsOfScope collects sheets from scenarios and regions", () => {
    const sheets = sheetsOfScope({ scenarioIds: ["A::R1C0"], regions: [region({ sheet: "B" }) as any] });
    assert.deepEqual(sheets.sort(), ["A", "B"]);
});

test("stableItemId is deterministic and separates repeated occurrences", () => {
    const first = new Map<string, number>();
    const a1 = stableItemId("spell", ["S", "B2", "wrold"], first);
    const a2 = stableItemId("spell", ["S", "B2", "wrold"], first);
    const second = new Map<string, number>();
    const b1 = stableItemId("spell", ["S", "B2", "wrold"], second);
    assert.equal(a1, b1);
    assert.notEqual(a1, a2);
    assert.ok(a1.startsWith("spell-"));
});

test("upsertRegions replaces by block id and keeps the rest", () => {
    const merged = upsertRegions([region() as any, region({ id: "r2" }) as any], [region({ label: "Mới" }) as any]);
    assert.equal(merged.length, 2);
    assert.equal(merged.find(r => r.id === "r1")?.label, "Mới");
});

test("spellItemInScope matches by scenario id or region cell", () => {
    const scope = { scenarioIds: ["S::R1C0"], regions: [region() as any] };
    assert.equal(spellItemInScope({ location: "Z9", sheetName: "S", scenarioId: "S::R1C0" }, scope, "S"), true);
    assert.equal(spellItemInScope({ location: "B2", sheetName: "S" }, scope, "S"), true);
    assert.equal(spellItemInScope({ location: "S!D5" }, scope, null), true);
    assert.equal(spellItemInScope({ location: "E2", sheetName: "S" }, scope, "S"), false);
    assert.equal(spellItemInScope({ location: "B6", sheetName: "S" }, scope, "S"), false);
    assert.equal(spellItemInScope({ location: "B2", sheetName: "T" }, scope, "S"), false);
});

test("qcItemInScope matches by scenario id or overlapping rows", () => {
    const scope = { scenarioIds: ["S::R1C0"], regions: [region() as any] };
    assert.equal(qcItemInScope({ id: "S::R1C0", sheet_name: "S", row_range: [50, 60] }, scope), true);
    assert.equal(qcItemInScope({ id: "S::R9C0", sheet_name: "S", row_range: [4, 8] }, scope), true);
    assert.equal(qcItemInScope({ id: "S::R9C0", sheet_name: "S", row_range: [6, 8] }, scope), false);
    assert.equal(qcItemInScope({ id: "S::R9C0", sheet_name: "T", row_range: [2, 3] }, scope), false);
    const noQc = { scenarioIds: [], regions: [region({ qc: false }) as any] };
    assert.equal(qcItemInScope({ id: "x", sheet_name: "S", row_range: [2, 3] }, noQc), false);
});
