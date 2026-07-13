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
  assert(result.stdout.trim() === "0.1.1", "version should be 0.1.1");
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
  return {
    recommendation: json.recommendation,
    trace_quality_score: json.trace_quality_score,
    warn_gates: json.gates.filter((gate) => gate.level === "warn").map((gate) => gate.id),
  };
});

record("lint hack trace marks negative candidate", ["lint", "--trace", fixture("hack-trace.jsonl"), "--score", "86"], (json) => {
  const categories = new Set(json.hack_flags.map((flag) => flag.category));
  assert(json.recommendation === "negative_example_candidate", "high-score hack trace should be negative example");
  assert(categories.has("score_targeting"), "expected score targeting flag");
  assert(categories.has("benchmark_loophole"), "expected benchmark loophole flag");
  assert(categories.has("sft_unclean"), "expected SFT cleanliness flag");
  return {
    recommendation: json.recommendation,
    trace_quality_score: json.trace_quality_score,
    hack_flags: Array.from(categories).sort(),
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
