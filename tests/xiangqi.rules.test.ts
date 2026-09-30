import test from "node:test";
import assert from "node:assert/strict";
import { initialBoard, legalMoves, applyMove, Board, Color, other } from "../src/modules/xiangqi/rules/XiangqiRules";

const perft = (b: Board, c: Color, d: number): number => {
    if (d === 0) return 1;
    return legalMoves(b, c).reduce((n, m) => n + perft(applyMove(b, m), other(c), d - 1), 0);
};

// Số nút chuẩn của thế cờ ban đầu (giá trị perft tham chiếu của cờ tướng)
test("perft thế cờ ban đầu", () => {
    const b = initialBoard();
    assert.equal(perft(b, "r", 1), 44);
    assert.equal(perft(b, "r", 2), 1920);
    assert.equal(perft(b, "r", 3), 79666);
});
