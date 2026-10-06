import { describe, expect, it } from "vitest";
import { checkAnswer, extractNumbers, matchFact, tolerance, type Fact } from "../src/grounding";
import { levelFacts } from "../src/tools";
import { levelsFor } from "./fixtures";

const texts = (s: string) => extractNumbers(s).map((t) => `${t.value}${t.percent ? "%" : ""}`);

describe("extractNumbers", () => {
  it("finds prices with decimals, thousands separators, a $ sign, or 100 and above", () => {
    expect(texts("Pivot 101.14, ES 5,400.25, $45, NQ 18250 and 1.2650")).toEqual([
      "101.14",
      "5400.25",
      "45",
      "18250",
      "1.265",
    ]);
  });

  it("keeps the sign of negative numbers but not of hyphenated ranges", () => {
    expect(texts("Return -3.21% (from -$1,200.50); zone 1.2650-1.2700")).toEqual([
      "-3.21%",
      "-1200.5",
      "1.265",
      "1.27",
    ]);
  });

  it("skips digits inside tickers, levels names and timeframes", () => {
    expect(texts("S001 R1 S3 on the 4H and 15M charts, BRK.B, XAU/USD")).toEqual([]);
  });

  it("skips dates, ratios and times", () => {
    expect(texts("As of 2026-10-02 (10/02/2026) at 14:30, R:R 1:3 or 1.5:2")).toEqual([]);
  });

  it("skips counts, periods and indicator lengths", () => {
    expect(
      texts("The 200-day average, 200 sessions, 150 trades, 52-week high, SMA 200, the 200 SMA, RSI 14, 120 pips"),
    ).toEqual([]);
  });

  it("skips small whole numbers, list markers and years", () => {
    expect(texts("1. Bias\n2) Levels\nIn 2024 and 2026 the 3 setups were 2 to 1")).toEqual([]);
  });

  it("keeps years written as prices", () => {
    expect(texts("Gold at 2,050 or $2050 or 2050.5")).toEqual(["2050", "2050", "2050.5"]);
  });

  it("reports percentages separately", () => {
    expect(extractNumbers("Win rate 45.5 % and 12%").map((t) => [t.text, t.percent])).toEqual([
      ["45.5", true],
      ["12", true],
    ]);
  });

  it("records the written precision", () => {
    expect(extractNumbers("101.1 101.14 101").map((t) => t.decimals)).toEqual([1, 2, 0]);
  });
});

const facts = levelFacts(levelsFor("S001"));

describe("matching", () => {
  it("allows half a unit in the last written digit, or 0.05% of the value", () => {
    const [token] = extractNumbers("101.14");
    expect(tolerance(token, facts[1])).toBeCloseTo(Math.max(0.005, 101.1367 * 0.0005), 6);
    expect(matchFact(token, facts)?.label).toBe("P");
    // 101 is within half a unit of both P (101.1367) and the close (101.23);
    // the nearer one wins.
    expect(matchFact(extractNumbers("101")[0], facts)?.label).toBe("P");
    expect(matchFact(extractNumbers("101.2")[0], facts)?.label).toBe("Close");
    expect(matchFact(extractNumbers("101.5")[0], facts)).toBeNull();
  });

  it("does not match a percentage against a price or the reverse", () => {
    const percentFact: Fact = { value: 12.5, label: "max_drawdown", ticker: "AAPL", kind: "backtest", source: "synthetic", unit: "percent" };
    expect(matchFact(extractNumbers("12.5")[0], [percentFact])).toBeNull();
    expect(matchFact(extractNumbers("12.5%")[0], [percentFact])?.label).toBe("max_drawdown");
  });

  it("matches the opposite sign only for signless facts", () => {
    const dd: Fact = { value: 12.5, label: "max_drawdown", ticker: "AAPL", kind: "backtest", source: "synthetic", unit: "percent", signless: true };
    const ret: Fact = { ...dd, label: "total_return", signless: false };
    expect(matchFact(extractNumbers("-12.5%")[0], [dd])?.label).toBe("max_drawdown");
    expect(matchFact(extractNumbers("-12.5%")[0], [ret])).toBeNull();
  });
});

describe("checkAnswer", () => {
  it("cites provided levels and flags the rest", () => {
    const result = checkAnswer("P at 101.14, R1 102.49, and a target of 110.40 near 52W.", facts);
    expect(result.citations.map((c) => [c.text, c.label, c.ticker])).toEqual([
      ["101.14", "P", "S001"],
      ["102.49", "R1", "S001"],
    ]);
    expect(result.unverified).toEqual([{ text: "110.40", value: 110.4 }]);
  });

  it("lists each citation and each unverified number once", () => {
    const result = checkAnswer("101.14 then 101.14 again; 150.5 and 150.5", facts);
    expect(result.citations).toHaveLength(1);
    expect(result.unverified).toEqual([{ text: "150.5", value: 150.5 }]);
  });

  it("does not flag numbers the user wrote in the question", () => {
    const result = checkAnswer("An entry at 99.50 sits just below S1 (99.87).", facts, "Is 99.50 a good entry?");
    expect(result.unverified).toEqual([]);
    expect(result.citations.map((c) => c.label)).toEqual(["S1"]);
  });

  it("flags every price-like number when no data was provided", () => {
    expect(checkAnswer("GBP/USD support 1.2650, resistance 1.2800.", []).unverified.map((u) => u.text)).toEqual([
      "1.2650",
      "1.2800",
    ]);
  });

  it("ignores percentages unless a percent fact was provided", () => {
    expect(checkAnswer("Risk 1% per trade with a stop 2.5% away.", facts).unverified).toEqual([]);
    const withPercent: Fact[] = [
      ...facts,
      { value: -3.2117, label: "total_return", ticker: "AAPL", kind: "backtest", source: "synthetic", unit: "percent" },
    ];
    const result = checkAnswer("Total return -3.21%, CAGR 4.4%.", withPercent);
    expect(result.citations.map((c) => c.label)).toEqual(["total_return"]);
    expect(result.unverified).toEqual([{ text: "4.4%", value: 4.4 }]);
  });
});
