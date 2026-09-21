#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultCasesRoot = path.resolve(here, "../../docs/金融经济与国际贸易测试资料集/02-测试集");

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function findCaseRoot(value) {
  if (!value) throw new Error("缺少 --case <案例目录或 FT-xxx>");
  const direct = path.resolve(value);
  if (fs.existsSync(path.join(direct, "case.json"))) return direct;
  const match = fs.readdirSync(defaultCasesRoot, { withFileTypes: true })
    .find((entry) => entry.isDirectory() && entry.name.startsWith(`${value}-`));
  if (!match) throw new Error(`找不到案例：${value}`);
  return path.join(defaultCasesRoot, match.name);
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function brier(probability, outcome) {
  return (probability - Number(outcome)) ** 2;
}

function checkInterval(errors, label, forecast) {
  const { point, interval_50: i50, interval_90: i90 } = forecast ?? {};
  if (![point, ...(i50 ?? []), ...(i90 ?? [])].every(Number.isFinite)) {
    errors.push(`${label} 的点预测或区间不是有限数字`);
    return;
  }
  if (i50.length !== 2 || i90.length !== 2) {
    errors.push(`${label} 的区间必须各有两个边界`);
    return;
  }
  if (i50[0] > point || point > i50[1]) errors.push(`${label} 的 50% 区间未包含点预测`);
  if (i90[0] > i50[0] || i50[1] > i90[1]) errors.push(`${label} 的 50% 区间未嵌套在 90% 区间内`);
}

function checkRanks(errors, label, values) {
  const sorted = [...values].sort((a, b) => a - b);
  const expected = Array.from({ length: values.length }, (_, index) => index + 1);
  if (JSON.stringify(sorted) !== JSON.stringify(expected)) errors.push(`${label} 必须是 1—${values.length} 的唯一完整排列`);
}

function checkScenarioSum(errors, response) {
  const scenarios = response.scenarios ?? response.regional_scenarios;
  if (!Array.isArray(scenarios)) return;
  const total = sum(scenarios.map((item) => item.probability));
  if (!Number.isFinite(total) || Math.abs(total - 1) > 0.02) errors.push(`情景概率之和为 ${total}，允许范围是 0.98—1.02`);
}

function checkEnvelope(errors, caseSpec, response) {
  const checkpointIndex = caseSpec.checkpoints.findIndex((item) => item.id === response.checkpoint);
  if (response.case_id !== caseSpec.case_id) errors.push("case_id 与案例不一致");
  if (checkpointIndex < 0) {
    errors.push("checkpoint 不属于本案例");
    return;
  }
  const checkpoint = caseSpec.checkpoints[checkpointIndex];
  const expectedPrevious = checkpointIndex === 0 ? null : caseSpec.checkpoints[checkpointIndex - 1].id;
  if (response.as_of !== checkpoint.as_of) errors.push("as_of 与当前检查点不一致");
  if (response.previous_checkpoint !== expectedPrevious) errors.push(`previous_checkpoint 应为 ${expectedPrevious ?? "null"}`);
  if (!Array.isArray(response.evidence_anchors) || response.evidence_anchors.length === 0) errors.push("evidence_anchors 不能为空");
  if (!response.update_delta || !Array.isArray(response.update_delta.changed) || !Array.isArray(response.update_delta.unchanged) || typeof response.update_delta.why !== "string") errors.push("update_delta 缺少 changed、unchanged 或 why");
  if (!Array.isArray(response.limitations)) errors.push("limitations 必须是数组");
}

function scoreFt001(response, outcomes, errors) {
  checkInterval(errors, "world_trade_growth", response.numeric_forecast);
  return {
    brier: {
      trade_growth_lt_0: brier(response.event_probabilities.trade_growth_lt_0, outcomes.binary_events.world_merchandise_trade_volume_growth_2009_lt_0),
      trade_growth_le_minus_5: brier(response.event_probabilities.trade_growth_le_minus_5, outcomes.binary_events.world_merchandise_trade_volume_growth_2009_le_minus_5),
    },
    point_absolute_error: Math.abs(response.numeric_forecast.point - outcomes.primary_target.first_release_outcome.value),
  };
}

function scoreFt002(response, outcomes, errors, warnings) {
  const briers = {};
  for (const id of ["C1", "C2", "C3", "C4"]) {
    const forecast = response.country_forecasts[id];
    const actual = outcomes.country_outcomes[id];
    checkInterval(errors, `${id}.gdp_growth`, forecast.gdp_growth);
    briers[`${id}.contraction`] = brier(forecast.contraction_probability, actual.contraction);
    briers[`${id}.depreciation`] = brier(forecast.currency_depreciation_ge_30_probability, actual.average_exchange_rate_depreciation_ge_30);
    briers[`${id}.current_account`] = brier(forecast.current_account_surplus_probability, actual.current_account_surplus);
  }
  checkRanks(errors, "country severity_rank", Object.values(response.country_forecasts).map((item) => item.severity_rank));
  briers.regional_at_least_three_contract = brier(response.regional_probabilities.at_least_three_contract, outcomes.regional_outcomes.at_least_three_contract);
  briers.regional_median_gdp_le_minus_5 = brier(response.regional_probabilities.median_gdp_growth_le_minus_5, outcomes.regional_outcomes.median_gdp_growth_le_minus_5);
  const contractionSum = sum(Object.values(response.country_forecasts).map((item) => item.contraction_probability));
  const regional = response.regional_probabilities.at_least_three_contract;
  const lower = Math.max(0, (contractionSum - 2) / 2);
  const upper = Math.min(1, contractionSum / 3);
  if (regional < lower - 1e-9 || regional > upper + 1e-9) errors.push(`至少三国收缩概率 ${regional} 与四国边际概率不相容；必要区间约为 ${lower.toFixed(3)}—${upper.toFixed(3)}`);
  const points = Object.values(response.country_forecasts).map((item) => item.gdp_growth.point).sort((a, b) => a - b);
  const median = (points[1] + points[2]) / 2;
  const medianEvent = response.regional_probabilities.median_gdp_growth_le_minus_5;
  if ((median <= -5 && medianEvent < 0.5) || (median > -5 && medianEvent > 0.5)) warnings.push("区域中位增长的点预测与事件概率方向不一致，请确认是否有意保留偏态或多峰分布");
  return { brier: briers };
}

function scoreFt003(response, outcomes, errors) {
  const briers = {};
  for (const id of ["K1", "K2", "K3", "K4"]) {
    const forecast = response.commodity_forecasts[id];
    const actual = outcomes.commodities[id];
    checkInterval(errors, `${id}.annual_average_price`, forecast.annual_average_price);
    briers[`${id}.decline_ge_20`] = brier(forecast.decline_ge_20_probability, actual.decline_ge_20);
    briers[`${id}.h2_low`] = brier(forecast.h2_low_probability, actual.annual_low_in_h2);
  }
  checkRanks(errors, "commodity drawdown_rank", Object.values(response.commodity_forecasts).map((item) => item.drawdown_rank));
  briers.basket_at_least_three = brier(response.basket_probabilities.at_least_three_decline_ge_20, outcomes.basket.at_least_three_decline_ge_20);
  briers.basket_all_four_lower = brier(response.basket_probabilities.all_four_lower, outcomes.basket.all_four_lower);
  return { brier: briers };
}

function scoreFt004(response, outcomes, errors) {
  const briers = {};
  for (const [key, result] of Object.entries(outcomes.binary)) briers[key] = brier(response.event_probabilities[key], result.value);
  for (const [key, forecast] of Object.entries(response.numeric_forecasts)) checkInterval(errors, key, forecast);
  return { brier: briers };
}

export function evaluate(caseRoot, response) {
  const caseSpec = readJson(path.join(caseRoot, "case.json"));
  const outcomes = readJson(path.join(caseRoot, "evaluator/outcomes.json"));
  const errors = [];
  const warnings = [];
  checkEnvelope(errors, caseSpec, response);
  checkScenarioSum(errors, response);
  let scores = {};
  if (caseSpec.case_id === "FT-001") scores = scoreFt001(response, outcomes, errors);
  else if (caseSpec.case_id === "FT-002") scores = scoreFt002(response, outcomes, errors, warnings);
  else if (caseSpec.case_id === "FT-003") scores = scoreFt003(response, outcomes, errors);
  else if (caseSpec.case_id === "FT-004") scores = scoreFt004(response, outcomes, errors);
  else errors.push(`尚不支持 ${caseSpec.case_id}`);
  return { valid: errors.length === 0, errors, warnings, scores };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const caseRoot = findCaseRoot(arg("--case"));
    const responseFile = arg("--response");
    if (!responseFile) throw new Error("缺少 --response <答案.json>");
    const result = evaluate(caseRoot, readJson(path.resolve(responseFile)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.valid ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
