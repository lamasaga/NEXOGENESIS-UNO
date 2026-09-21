import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate } from "../tools/eval/score-response.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../docs/金融经济与国际贸易测试资料集/02-测试集");
const caseRoot = (name) => path.join(root, name);
const envelope = (caseId, checkpoint, asOf, previous) => ({
  case_id: caseId,
  checkpoint,
  as_of: asOf,
  previous_checkpoint: previous,
  evidence_anchors: [{ supports: "test", kind: "support", anchor: "S01", use: "test" }],
  update_delta: { changed: [], unchanged: ["baseline"], why: "initial" },
  limitations: [],
});
const interval = (point) => ({ point, interval_50: [point - 1, point + 1], interval_90: [point - 2, point + 2] });

test("FT-001 catches scenario sums and interval nesting", () => {
  const response = {
    ...envelope("FT-001", "T0", "2008-09-12T23:59:59Z", null),
    event_probabilities: { trade_growth_lt_0: 0.5, trade_growth_le_minus_5: 0.2 },
    numeric_forecast: { ...interval(1), interval_90: [0.5, 1.5] },
    scenarios: [{ probability: 0.4 }, { probability: 0.4 }, { probability: 0.4 }],
  };
  const result = evaluate(caseRoot("FT-001-2008金融危机与全球贸易骤降"), response);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.includes("情景概率")));
  assert.ok(result.errors.some((item) => item.includes("区间")));
});

test("FT-002 catches duplicate ranks and impossible regional marginal", () => {
  const country = (rank) => ({ contraction_probability: 0.1, currency_depreciation_ge_30_probability: 0.2, current_account_surplus_probability: 0.3, severity_rank: rank, gdp_growth: interval(2) });
  const response = {
    ...envelope("FT-002", "T0", "1997-06-30T23:59:59Z", null),
    country_forecasts: { C1: country(1), C2: country(1), C3: country(3), C4: country(4) },
    regional_probabilities: { at_least_three_contract: 0.9, median_gdp_growth_le_minus_5: 0.1 },
    regional_scenarios: [{ probability: 0.3 }, { probability: 0.3 }, { probability: 0.4 }],
  };
  const result = evaluate(caseRoot("FT-002-1997东南亚四国金融危机传播"), response);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.includes("唯一完整排列")));
  assert.ok(result.errors.some((item) => item.includes("边际概率不相容")));
});

test("FT-003 accepts coherent cross-field values", () => {
  const commodity = (rank) => ({ annual_average_price: interval(100), decline_ge_20_probability: 0.5, h2_low_probability: 0.5, drawdown_rank: rank });
  const response = {
    ...envelope("FT-003", "T0", "2013-10-15T23:59:59Z", null),
    commodity_forecasts: { K1: commodity(1), K2: commodity(2), K3: commodity(3), K4: commodity(4) },
    basket_probabilities: { at_least_three_decline_ge_20: 0.5, all_four_lower: 0.5 },
    scenarios: [{ probability: 0.2 }, { probability: 0.3 }, { probability: 0.5 }],
  };
  const result = evaluate(caseRoot("FT-003-2014大宗商品周期转折与突发冲击"), response);
  assert.equal(result.valid, true);
});

test("FT-004 checks previous checkpoint", () => {
  const response = {
    ...envelope("FT-004", "T1", "1994-09-30T23:59:59Z", null),
    event_probabilities: {
      recession_starts_in_target_year: 0.2,
      real_gdp_growth_below_1_pct: 0.2,
      cpi_december_yoy_at_least_4_pct: 0.2,
      annual_unemployment_at_least_6_5_pct: 0.2,
      real_gdp_growth_slows_at_least_1pp: 0.5,
      policy_rate_cut_by_year_end: 0.5,
    },
    numeric_forecasts: { real_gdp_growth: interval(2), cpi_december_yoy: interval(3), annual_unemployment: interval(6) },
    scenarios: [{ probability: 0.4 }, { probability: 0.3 }, { probability: 0.3 }],
  };
  const result = evaluate(caseRoot("FT-004-1994美国货币紧缩与软着陆"), response);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.includes("previous_checkpoint")));
});
