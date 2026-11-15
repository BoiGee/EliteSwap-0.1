import { describe, expect, it } from "vitest";
import { splitSale } from "./resellerSplit";

describe("splitSale", () => {
  it("gives Elite Swap the list price plus half the markup", () => {
    expect(splitSale(210, 250)).toEqual({ platform: 230, reseller: 20 });
    expect(splitSale(1000, 1300)).toEqual({ platform: 1150, reseller: 150 });
  });

  it("gives Elite Swap the whole price when sold at list", () => {
    expect(splitSale(130, 130)).toEqual({ platform: 130, reseller: 0 });
  });

  it("rounds an odd-cent markup the way the server does (half cent to Elite Swap)", () => {
    // server: round(117 + 3.05 / 2, 2) = round(118.525, 2) = 118.53
    expect(splitSale(117, 120.05)).toEqual({ platform: 118.53, reseller: 1.52 });
    expect(splitSale(210, 210.01)).toEqual({ platform: 210.01, reseller: 0 });
  });

  it("always adds up to the reseller's price", () => {
    for (const [list, price] of [[130, 199.99], [2000, 2333.33], [10500, 12000.07]]) {
      const s = splitSale(list, price);
      expect(Math.round((s.platform + s.reseller) * 100)).toBe(Math.round(price * 100));
    }
  });
});
