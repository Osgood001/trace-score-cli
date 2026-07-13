# Trace Score CLI

Trace scoring and curation CLI for Playground / Harbor / OpenCode trajectories.

The v0 focus is post-submission trace quality:

- deterministic format and completeness gates
- user-input localization and intervention classification
- hack / shortcut heuristics for high-score traces
- optional OpenAI-compatible LLM audit for expensive high-score review
- JSON output suitable for a Playground sidecar evaluator

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
- `gates`: deterministic pass/warn/fail checks
- `user_flags`: user-input/intervention candidates
- `hack_flags`: shortcut, leakage, score-targeting, and SFT-cleanliness signals
- `recommendation`: `keep_for_training`, `needs_human_review`, `drop_for_training`, or `negative_example_candidate`

The CLI intentionally separates task reward from trace quality. A high verifier
score is only an input to `audit-highscore`; it is not treated as evidence that a
trace is clean for post-training.
