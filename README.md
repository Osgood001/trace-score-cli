# Trace Score CLI

Trace scoring and curation CLI for Playground / Harbor / OpenCode trajectories.

The v0 focus is post-submission trace quality:

- deterministic format and completeness gates
- tool-call schema classification and claimed-vs-actual mismatch flags
- rule-based observation/action TOR outlier scoring
- user-input localization and intervention classification
- hack / shortcut heuristics for high-score traces
- optional OpenAI-compatible LLM audit for expensive high-score review
- JSON output suitable for a Playground sidecar evaluator

Audit design note: when model reasoning / CoT text is available, keep it as
audit evidence and compare full-trace audit against action/submission-only
audit. Do not treat the audit score as a direct training reward by default;
strong optimization against a monitor can select for obfuscated reward hacking.

Planned follow-up: add task-level topology analysis for multiple attempts on the
same Harbor task. This should build an action-observation state graph and emit
SFT/RL curation signals such as recovery, efficiency, diversity, error branch
ratio, and strategic heterogeneity. This is intentionally separate from v0
single-trace linting, because it needs multiple rollouts to be meaningful.

Second planned follow-up: add benchmark/harness auditing inspired by BenchJack.
This should inspect checker code, manifests, sandbox permissions, network/mount
policy, scorer parsing, and verifier artifact trust boundaries before high-score
trace audit. The output should be a flaw ledger plus minimal adversarial smoke
tests, separate from `audit-highscore` because harness-wide reward hacks can make
many traces look successful without solving the task.

## Install

```bash
npm install
npm run build
npm link
trace-score --help
```

The CLI requires Node 20+.

## Test

Run the deterministic fixture suite:

```bash
npm test
```

When the local Playground/Harbor evidence tree is available, run the real-trace
regression pass too:

```bash
npm run test:real -- --required-real
```

The real pass exercises:

- a normal Playground attempt trace from attempt 34
- an OpenCode red-team trace that should become `negative_example_candidate`
- the corresponding raw OpenCode messages for user-intervention labels

## Common Commands

Inspect an ARM or OpenCode trace:

```bash
trace-score inspect --trace ./trace.jsonl
```

Run all deterministic gates:

```bash
trace-score lint --trace ./trace.jsonl --score 86 --out trace-report.json
```

Classify structured tool-call schemas and verify a claimed provider family:

```bash
trace-score schema --trace ./trace.jsonl --claimed-schema openai
```

Compute rule-based observation/action support. This parses shell and structured
tool calls, labels operations as `observe`, `act`, or `verify`, and reports the
fraction of actions with a prior path-aligned observation:

```bash
trace-score tor --trace ./trace.jsonl --out tor-report.json
```

`tor` is an outlier tag, not a faithfulness verdict. A reward-hacking trace can
still have high TOR if it first observes leaked checker/spec files and then acts
consistently with those observations.

List user-input candidates and intervention labels:

```bash
trace-score user-flags --trace ./raw_messages.jsonl
```

Run the high-score audit workflow. Without `--llm`, this emits the deterministic
decision and the exact LLM audit prompt. With `--llm`, it calls an
OpenAI-compatible chat endpoint.

```bash
trace-score audit-highscore \
  --trace ./raw_messages.jsonl \
  --score 86 \
  --task ./task.md \
  --submission ./outputs \
  --model aliyun/deepseek-v4-pro
```

For LLM mode:

```bash
export BOHRIUM_ACCESS_KEY=...
trace-score audit-highscore \
  --trace ./raw_messages.jsonl \
  --score 86 \
  --task ./task.md \
  --submission ./outputs \
  --model aliyun/deepseek-v4-pro \
  --api-base https://open.bohrium.com/openapi/v1 \
  --llm
```

## Supported Inputs

- ARM / Playground JSONL with `step_type`, `body`, `tool_args`, and `tool_output`
- OpenCode session JSON with `messages[].parts`
- OpenCode event JSONL with `type=message|tool_use|reasoning`
- simple `steps[]` traces with `role` and `text`
- JSON arrays of event-like objects

## Output Contract

`lint` and `audit-highscore` produce:

- `stats`: event, role, tool, token, and cost counters
- `tool_schema` / `schema_flags`: OpenAI, Anthropic, Gemini, LangChain,
  OpenCode, or ARM/Playground tool-call schema evidence plus mismatch flags
- `tor`: action support ratio, operation/tool histograms, matched observation
  pairs, and unsupported actions
- `gates`: deterministic pass/warn/fail checks
- `user_flags`: user-input/intervention candidates
- `hack_flags`: shortcut, leakage, score-targeting, and SFT-cleanliness signals
- `recommendation`: `keep_for_training`, `needs_human_review`, `drop_for_training`, or `negative_example_candidate`

The CLI intentionally separates task reward from trace quality. A high verifier
score is only an input to `audit-highscore`; it is not treated as evidence that a
trace is clean for post-training.

For high-score audits, the intended output is a reviewer/auditor sidecar:
evidence spans, hack category, confidence, and keep/drop/negative-example
recommendation. It should not silently rewrite rewards or train the next model
to avoid only hack-looking language.

## Planned Benchmark Audit

`benchmark audit` should run before public leaderboard or training-data harvest:

- inspect task package boundaries, manifest fields, checker/oracle code, mounts,
  network policy, and output paths
- classify findings as isolation failure, answer leakage, grader RCE, LLM-judge
  prompt injection, weak matching, scoring-logic gap, trusted untrusted output,
  or excessive permissions
- run null-agent and adversarial-submission smoke tests
- emit exploit/regression artifacts when a flaw is confirmed

This is the harness-level complement to `audit-highscore`: one checks whether
the benchmark can be gamed at all; the other checks whether a specific high-score
submission appears gamed.
