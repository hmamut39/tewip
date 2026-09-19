import { describe, it } from "node:test";
function same(actual, expected) {
  if (actual !== expected) {
    const e = new Error(`Expected: ${expected}\nReceived: ${actual}`);
    e.name = "AssertionError";
    throw e;
  }
}
describe("shop", () => {
  it("adds numbers", () => same(2 + 2, 4));
  it("computes the total", () => same(2 + 2 - 1, 4));
  it("reaches the pricing service", async () => { await fetch("http://127.0.0.1:9/price"); });
});
