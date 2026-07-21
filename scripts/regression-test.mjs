#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const cliPath = resolve(repoRoot, "dist/index.js");
const args = new Set(process.argv.slice(2));
const outArg = process.argv.find((arg) => arg.startsWith("--out="));
const outPath = outArg ? resolve(process.cwd(), outArg.slice("--out=".length)) : undefined;
const runReal = args.has("--real");
const requireReal = args.has("--required-real");

const results = [];

function displayArg(arg) {
  if (arg === null || arg === undefined) return arg;
  if (typeof arg !== "string") return String(arg);
  const parentRoot = resolve(repoRoot, "..");
  if (arg.startsWith(repoRoot)) return relative(repoRoot, arg) || ".";
  if (arg.startsWith(parentRoot)) return `../${relative(parentRoot, arg)}`;
  return arg;
}

function runCli(commandArgs) {
  const result = spawnSync(process.execPath, [cliPath, ...commandArgs], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  return result;
}

function parseJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`stdout was not JSON: ${stdout.slice(0, 500)}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function record(name, commandArgs, check, options = {}) {
  const started = Date.now();
  const result = runCli(commandArgs);
  const entry = {
    name,
    command: `trace-score ${commandArgs.map(displayArg).join(" ")}`,
    fixture: displayArg(commandArgs[commandArgs.indexOf("--trace") + 1] || null),
    passed: false,
    duration_ms: Date.now() - started,
  };
  if (result.status !== 0) {
    entry.error = `exit ${result.status}: ${result.stderr || result.stdout}`;
    results.push(entry);
    return;
  }
  try {
    const json = options.json === false ? result.stdout : parseJson(result.stdout);
    entry.observed = check(json, result);
    entry.passed = true;
  } catch (error) {
    entry.error = String(error instanceof Error ? error.message : error);
  }
  results.push(entry);
}

function fixture(name) {
  return `test/fixtures/${name}`;
}

record("version command", ["version"], (_json, result) => {
  assert(result.stdout.trim() === "0.2.0-beta.3", "version should be 0.2.0-beta.3");
  return { version: result.stdout.trim() };
}, { json: false });

record("inspect clean OpenCode session", ["inspect", "--trace", fixture("opencode-clean-session.json")], (json) => {
  assert(json.format === "opencode_session_json", "expected OpenCode session parser");
  assert(json.stats.events >= 5, "expected multiple normalized events");
  assert(json.stats.toolResults >= 2, "expected tool result events");
  return {
    format: json.format,
    events: json.stats.events,
    toolResults: json.stats.toolResults,
  };
});

record("lint clean trace keeps training candidate", ["lint", "--trace", fixture("opencode-clean-session.json"), "--score", "82"], (json) => {
  assert(json.ok === true, "clean trace should pass hard gates");
  assert(json.recommendation === "keep_for_training", "clean trace should stay trainable");
  assert(json.trace_quality_score >= 85, "expected high trace quality");
  assert(json.tool_schema.primary_detected === "opencode", "expected OpenCode tool schema detection");
  return {
    recommendation: json.recommendation,
    trace_quality_score: json.trace_quality_score,
    tool_schema: json.tool_schema.primary_detected,
    warn_gates: json.gates.filter((gate) => gate.level === "warn").map((gate) => gate.id),
  };
});

record("tor computes observation/action support", ["tor", "--trace", fixture("opencode-clean-session.json")], (json) => {
  assert(json.schema_version === "trace-score-cli/tor/v0", "expected TOR report schema");
  assert(json.observation_count >= 2, "expected observation commands");
  assert(json.action_count >= 1, "expected at least one action command");
  assert(json.resource_counts["task.md"] === 1, "expected task.md observation resource");
  return {
    tor: json.tor,
    observations: json.observation_count,
    actions: json.action_count,
    unsupported: json.unsupported_action_count,
  };
});

record("schema flags claimed/actual mismatch", ["schema", "--trace", fixture("openai-claimed-anthropic.json")], (json) => {
  const categories = new Set(json.schema_flags.map((flag) => flag.category));
  assert(json.tool_schema.claimed_normalized === "anthropic", "expected claimed Anthropic family");
  assert(json.tool_schema.primary_detected === "openai", "expected detected OpenAI family");
  assert(categories.has("tool_schema_claim_mismatch"), "expected schema mismatch flag");
  assert(json.tool_schema.missing_tool_results.length === 0, "OpenAI call/result should pair");
  return {
    claimed: json.tool_schema.claimed_normalized,
    detected: json.tool_schema.primary_detected,
    flags: Array.from(categories).sort(),
  };
});

record("schema validates Anthropic tool loop", ["schema", "--trace", fixture("anthropic-tool-use.json")], (json) => {
  assert(json.tool_schema.primary_detected === "anthropic", "expected Anthropic schema detection");
  assert(json.schema_flags.length === 0, "valid Anthropic tool loop should have no schema flags");
  assert(json.tool_schema.calls === 1 && json.tool_schema.results === 1, "expected paired tool_use/tool_result");
  return {
    detected: json.tool_schema.primary_detected,
    calls: json.tool_schema.calls,
    results: json.tool_schema.results,
  };
});

record("schema accepts LangChain function_name tool calls", ["schema", "--trace", fixture("langchain-function-name-tools.json")], (json) => {
  assert(json.tool_schema.primary_detected === "langchain", "expected LangChain schema detection");
  assert(json.tool_schema.calls === 1, "expected one LangChain tool call");
  assert(json.tool_schema.results === 1, "expected one LangChain tool result");
  assert(json.tool_schema.matched_call_ids === 1, "expected LangChain call/result pairing");
  assert(json.tool_schema.observations[0].toolName === "Write", "expected function_name as tool name");
  assert(json.tool_schema.observations[0].callId === "call_write_1", "expected tool_call_id as call id");
  assert(!json.schema_flags.some((flag) => flag.category === "malformed_tool_call_schema"), "function_name call should not be malformed");
  return {
    detected: json.tool_schema.primary_detected,
    schemas: json.tool_schema.detected_schemas,
    calls: json.tool_schema.calls,
    results: json.tool_schema.results,
  };
});

record("schema detects malformed OpenAI arguments", ["lint", "--trace", fixture("openai-malformed-args.json"), "--score", "91"], (json) => {
  const categories = new Set(json.schema_flags.map((flag) => flag.category));
  assert(json.tool_schema.primary_detected === "openai", "expected OpenAI schema detection");
  assert(categories.has("malformed_tool_call_schema"), "expected malformed argument flag");
  assert(json.recommendation === "needs_human_review" || json.recommendation === "negative_example_candidate", "malformed high-score trace should not be keep_for_training");
  return {
    recommendation: json.recommendation,
    trace_quality_score: json.trace_quality_score,
    flags: Array.from(categories).sort(),
  };
});

record("schema detects Gemini function parts", ["schema", "--trace", fixture("gemini-function-parts.json")], (json) => {
  assert(json.tool_schema.primary_detected === "gemini", "expected Gemini schema detection");
  assert(json.tool_schema.calls === 1 && json.tool_schema.results === 1, "expected Gemini call and response");
  return {
    detected: json.tool_schema.primary_detected,
    schemas: json.tool_schema.detected_schemas,
  };
});

record("lint hack trace marks negative candidate", ["lint", "--trace", fixture("hack-trace.jsonl"), "--score", "86"], (json) => {
  const categories = new Set(json.hack_flags.map((flag) => flag.category));
  assert(json.recommendation === "negative_example_candidate", "high-score hack trace should be negative example");
  assert(categories.has("score_targeting"), "expected score targeting flag");
  assert(categories.has("benchmark_loophole"), "expected benchmark loophole flag");
  assert(categories.has("sft_unclean"), "expected SFT cleanliness flag");
  assert(categories.has("reference_value_copy"), "expected deterministic reference-copy flag");
  assert(categories.has("redteam_prompt_mirror"), "expected deterministic red-team mirror flag");
  assert(json.provenance.hack_risk >= 80, "expected high deterministic provenance hack risk");
  assert(json.provenance.triggered_gates.includes("G1_reference_value_copy"), "expected G1 provenance gate");
  assert(json.provenance.triggered_gates.includes("G2_redteam_prompt_mirror"), "expected G2 provenance gate");
  return {
    recommendation: json.recommendation,
    trace_quality_score: json.trace_quality_score,
    hack_flags: Array.from(categories).sort(),
    provenance: {
      hack_risk: json.provenance.hack_risk,
      provenance_sufficiency: json.provenance.provenance_sufficiency,
      gates: json.provenance.triggered_gates,
    },
  };
});

record("provenance keeps honest fallback in review lane", ["lint", "--trace", fixture("honest-fallback-computation.jsonl"), "--score", "5"], (json) => {
  const categories = new Set(json.hack_flags.map((flag) => flag.category));
  assert(json.recommendation === "needs_human_review", "low-score honest fallback should stay in human review");
  assert(!categories.has("surrogate_highscore_without_computation"), "fallback should not escalate without high score and missing computation");
  assert(json.provenance.hack_risk < 50, "positive computation should keep hack risk low");
  assert(json.provenance.provenance_sufficiency >= 40, "computed fallback should retain reviewable provenance");
  assert(json.provenance.triggered_gates.includes("G4_surrogate_or_fallback_outputs"), "expected fallback provenance gate");
  assert(json.provenance.triggered_gates.includes("G6_positive_computation_evidence"), "expected positive computation guard");
  return {
    recommendation: json.recommendation,
    trace_quality_score: json.trace_quality_score,
    hack_flags: Array.from(categories).sort(),
    provenance: {
      hack_risk: json.provenance.hack_risk,
      provenance_sufficiency: json.provenance.provenance_sufficiency,
      gates: json.provenance.triggered_gates,
    },
  };
});

record("tor surfaces unsupported hack write", ["tor", "--trace", fixture("hack-trace.jsonl")], (json) => {
  assert(json.action_count === 1, "expected one write action");
  assert(json.unsupported_action_count === 1, "expected unsupported redteam report write");
  assert(json.unsupported_actions[0].resources.includes("redteam_report.md"), "expected redteam report resource");
  return {
    tor: json.tor,
    actions: json.action_count,
    unsupported: json.unsupported_action_count,
  };
});

record("structured support scores scientific tool traces", ["structured-support", "--trace", fixture("scientific-structured-tools.json")], (json) => {
  assert(json.schema_version === "trace-score-cli/structured-support/v0", "expected structured support schema");
  assert(json.call_count === 1, "expected one structured tool call");
  assert(json.result_count === 1, "expected one structured tool result");
  assert(json.pairing_support === 1, "expected call/result pairing");
  assert(json.query_support === 1, "expected grounded query argument");
  assert(json.final_answer_support >= 0.5, "expected supported final claims");
  return {
    support: json.support,
    query_support: json.query_support,
    pairing_support: json.pairing_support,
    final_answer_support: json.final_answer_support,
  };
});

record("user-flags catches intervention category", ["user-flags", "--trace", fixture("hack-trace.jsonl")], (json) => {
  const categories = new Set(json.user_flags.map((flag) => flag.category));
  assert(categories.has("hack_steering"), "expected hack steering user flag");
  assert(categories.has("bounded_redteam_instruction"), "expected bounded red-team label");
  return {
    user_flag_count: json.user_flags.length,
    categories: Array.from(categories).sort(),
  };
});

record("secret exposure is a hard failure", ["lint", "--trace", fixture("secret-leak.json"), "--score", "10"], (json) => {
  const secretGate = json.gates.find((gate) => gate.id === "secret_scan");
  assert(secretGate?.level === "fail", "secret scan should fail");
  assert(json.recommendation === "drop_for_training", "secret leak should be dropped");
  return {
    recommendation: json.recommendation,
    secret_scan: secretGate.level,
  };
});

record("audit-highscore emits deterministic prompt", ["audit-highscore", "--trace", fixture("hack-trace.jsonl"), "--score", "86"], (json) => {
  assert(json.should_audit === true, "high score should trigger audit");
  assert(json.llm_prompt.includes("Return strict JSON"), "audit prompt should be explicit");
  assert(json.deterministic_report.recommendation === "negative_example_candidate", "deterministic report should flag negative candidate");
  return {
    should_audit: json.should_audit,
    deterministic_recommendation: json.deterministic_report.recommendation,
    prompt_chars: json.llm_prompt.length,
  };
});

record("score produces label-free automatic three-layer fusion", [
  "score",
  "--trace", fixture("opencode-clean-session.json"),
  "--task", "README.md",
  "--llm-result", fixture("llm-faithful.json"),
], (json) => {
  assert(json.schema_version === "trace-score-cli/score/v1", "expected unified score schema");
  assert(json.engine === "trace-score-cli/0.2.0-beta.3+auto-provenance-fusion-v1", "expected automatic fusion engine");
  assert(json.score_input === null, "automatic score must not consume Harbor as a scoring signal");
  assert(json.reports.lint.score_input === undefined, "lint report must omit score_input");
  assert(json.reports.automatic_score.label_inputs_used === false, "automatic score must declare label-free inputs");
  assert(!json.reports.automatic_score.llm_user_prompt.includes("manual_group"), "prompt must omit manual labels");
  assert(!json.reports.automatic_score.llm_user_prompt.includes("fidelity_label"), "prompt must omit fidelity labels");
  assert(json.components.llm_no_hack_score === 100, "continuous hack_risk must map to no-hack score");
  assert(json.components.provenance_gate_score === 97.5, "provenance must combine no-hack and sufficiency");
  const expected = (
    json.components.rule_score
    + json.components.provenance_gate_score
    + json.components.llm_no_hack_score
  ) / 3;
  assert(Math.abs(json.score - expected) < 1e-6, "score must equal the simple three-layer mean");
  return {
    score: json.score,
    components: json.components,
    provenance_formula: json.reports.automatic_score.provenance_formula,
  };
});

const realCases = [
  {
    name: "real attempt 34 lint",
    trace: resolve(repoRoot, "../playground-atif-attempt34/trace34.json"),
    command: (trace) => ["lint", "--trace", trace, "--score", "100"],
    check: (json) => {
      assert(json.format === "arm_steps_json", "expected ARM steps JSON");
      assert(json.ok === true, "attempt 34 should not fail hard gates");
      assert(json.stats.userInputCandidates > 0, "attempt 34 should expose user/context events");
      return {
        format: json.format,
        events: json.stats.events,
        recommendation: json.recommendation,
        trace_quality_score: json.trace_quality_score,
      };
    },
  },
  {
    name: "real red-team trace audit",
    trace: resolve(repoRoot, "../edgebench-repro/redteam-opencode-20260712/1_harbor-phys-cluster-15931-paper-813062335483609088/work/trace.jsonl"),
    command: (trace) => ["audit-highscore", "--trace", trace, "--score", "86"],
    check: (json) => {
      assert(json.should_audit === true, "red-team score should trigger audit");
      assert(json.deterministic_report.recommendation === "negative_example_candidate", "red-team should be negative candidate");
      assert(json.deterministic_report.hack_flags.length >= 3, "expected multiple hack flags");
      return {
        recommendation: json.deterministic_report.recommendation,
        events: json.deterministic_report.stats.events,
        hack_flag_count: json.deterministic_report.hack_flags.length,
        trace_quality_score: json.deterministic_report.trace_quality_score,
      };
    },
  },
  {
    name: "real red-team raw user flags",
    trace: resolve(repoRoot, "../edgebench-repro/redteam-opencode-20260712/1_harbor-phys-cluster-15931-paper-813062335483609088/work/raw_messages.jsonl"),
    command: (trace) => ["user-flags", "--trace", trace],
    check: (json) => {
      const categories = new Set(json.user_flags.map((flag) => flag.category));
      assert(categories.has("hack_steering"), "expected raw trace hack steering flag");
      return {
        user_flag_count: json.user_flags.length,
        categories: Array.from(categories).sort(),
      };
    },
  },
];

if (runReal || requireReal) {
  for (const testCase of realCases) {
    if (!existsSync(testCase.trace)) {
      const entry = {
        name: testCase.name,
        command: `trace-score ${testCase.command(testCase.trace).map(displayArg).join(" ")}`,
        fixture: relative(repoRoot, testCase.trace),
        passed: !requireReal,
        skipped: !requireReal,
        error: requireReal ? "required real fixture is missing" : undefined,
      };
      results.push(entry);
      continue;
    }
    record(testCase.name, testCase.command(testCase.trace), testCase.check);
  }
}

const failed = results.filter((entry) => !entry.passed);
const summary = {
  schema_version: "trace-score-cli/test-summary/v0",
  generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  real_fixture_tests_enabled: runReal || requireReal,
  results,
};

if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`);
}

for (const entry of results) {
  const mark = entry.passed ? "PASS" : "FAIL";
  console.log(`${mark} ${entry.name}`);
  if (!entry.passed && entry.error) console.log(`  ${entry.error}`);
}

if (outPath) console.log(`wrote ${outPath}`);
if (failed.length) process.exit(1);
