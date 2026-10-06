import { describe, expect, it } from "vitest";
import { backtestBlock, backtestFacts, nullMetricClaims } from "../src/backtest";
import type { BacktestRun } from "../src/quant";
import { QUANT_METRICS } from "./fixtures";

const RUN: BacktestRun = {
  backtestId: 7,
  strategy: "Trend Following",
  symbol: "AAPL",
  startDate: "2023-01-01",
  endDate: "2023-06-30",
  riskProfile: "No Risk Management",
  initialCapital: 100_000,
  synthetic: true,
  dataFile: "data/sample_data.csv",
  dataDescription: "Synthetic daily bars.",
  metrics: { ...QUANT_METRICS, win_rate: 100, avg_loss: null, num_trades: 1, profit_factor: null, sharpe_ratio: null },
  undefinedMetrics: { avg_loss: "no losing trades", profit_factor: "no losing trades" },
  periodNote: null,
};

describe("backtestBlock", () => {
  it("writes n/a and quant's reason for null metrics, and a rule against numbers for them", () => {
    const block = backtestBlock(RUN);
    expect(block).toContain("profit_factor (Profit factor): n/a (no losing trades); quant has no value for it");
    expect(block).toContain("avg_loss (Average loss, currency): n/a (no losing trades); quant has no value for it");
    // A null without a reason still says n/a, and says quant gave none.
    expect(block).toContain("sharpe_ratio (Sharpe ratio): n/a (quant gave no reason); quant has no value for it");
    expect(block).toContain("win_rate (Win rate, percent): 100");
    expect(block).toContain("never a number");
  });

  it("has no n/a rule when every metric has a value, and carries the period note", () => {
    const full = backtestBlock({ ...RUN, metrics: QUANT_METRICS, undefinedMetrics: {}, periodNote: "The period was cut." });
    expect(full).not.toContain("n/a");
    expect(full.split("\n")[1]).toBe("The period was cut.");
  });

  it("gives the post-check no fact for a null metric", () => {
    const labels = backtestFacts(RUN).map((f) => f.label);
    expect(labels).not.toContain("Profit factor");
    expect(labels).not.toContain("Average loss");
    expect(labels).toContain("Win rate");
  });
});

describe("nullMetricClaims", () => {
  const claim = (text: string, metric: string, reason = "no losing trades") =>
    `${text} given for ${metric}, which quant reports as n/a (${reason})`;

  it.each([
    ["The profit factor was 2.35.", [[claim("2.35", "Profit factor"), 2.35]]],
    ["Profit factor: 3", [[claim("3", "Profit factor"), 3]]],
    ["Average loss of -$420.50", [[claim("-420.50", "Average loss"), -420.5]]],
    ["avg loss $1,250.00 per trade", [[claim("1,250.00", "Average loss"), 1250]]],
    ["a Sharpe ratio around 1.2", [[claim("1.2", "Sharpe ratio", "quant gave no reason"), 1.2]]],
  ] as const)("flags %j", (reply, expected) => {
    expect(nullMetricClaims(reply, [RUN]).map((c) => [c.text, c.value])).toEqual(expected);
  });

  it.each([
    "Profit factor: n/a (no losing trades).",
    "The profit factor is undefined because no trade lost money, over 1 trade.",
    "Profit factor is not defined, and the win rate is 100%.",
    "Sharpe ratio n/a; volatility 9.88%.",
    "No profit factor. 2.35 is something else.",
    "Average loss over 3 sessions: none.",
    "Win rate 100% and total return 0.75%.",
  ])("does not flag %j", (reply) => {
    expect(nullMetricClaims(reply, [RUN])).toEqual([]);
  });

  it("checks nothing when every metric has a value", () => {
    expect(nullMetricClaims("Profit factor 2.35", [{ ...RUN, metrics: QUANT_METRICS }])).toEqual([]);
    expect(nullMetricClaims("Profit factor 2.35", [])).toEqual([]);
  });
});
