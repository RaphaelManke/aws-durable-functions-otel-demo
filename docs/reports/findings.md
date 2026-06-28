# OTel SDK Findings

Observations from static trace analysis against the AWS Lambda Durable Functions OTel SDK.
Each finding is a concrete, reproducible observation backed by trace data.

---

## FIND-001: `durable.operation.id` hash collisions cause incorrect cross-function span links

- **Severity:** High
- **Status:** Open
- **Category:** Trace quality / Span links

### Description

The SDK assigns `durable.operation.id` based on the sequential position of a step within a
function (i.e. step #1 always gets the same hash, step #2 always gets the same hash, etc.).
Because this hash is position-based and not scoped to a specific function or execution, two
different steps in two different functions that occupy the same position get the same
`durable.operation.id`.

Each inner step span carries an OTel **link** pointing to the inner span of the previous step
in the execution. The link target is resolved using the `durable.operation.id`. When two
functions share an `op.id` value, the link from a step in one function resolves to a step
span in the *other* function — producing a wrong cross-function causal chain.

### Observed values

| Function | Step name | `durable.operation.id` | Span ID |
| :--- | :--- | :--- | :--- |
| `durable-workflow` | `validate` (step 1) | `c4ca4238a0b92382` | `7442731d2c090cdd` |
| `durable-enrich` | `enrich` (step 1) | `c4ca4238a0b92382` | `004e261792dcf157` |

Both are step #1 in their respective functions — same hash, different functions.

### Incorrect link chain produced

```
notify (inner)  ──link──►  enrich inner (durable-enrich)
                                   │
                                   └──link──►  validate inner (durable-workflow)
```

### Expected link chain

```
notify (inner)  ──link──►  process inner (durable-workflow)
                                   │
                                   └──link──►  validate inner (durable-workflow)
```

The link from `enrich (inner)` should point to the preceding step *within the same function*
(`validate` in `durable-workflow` for the parent, or nothing for the child since `enrich` is
step #1). Instead it crosses into the sibling function's span.

### Trace evidence

- Trace ID: `6a410bd8697c623910a1cd6120199dba`
- `enrich (inner)` span: `004e261792dcf157` → link → `7442731d2c090cdd` (`validate inner` in `durable-workflow`)
- `notify (inner)` span: `3f97b32cd922cfed` → link → `004e261792dcf157` (`enrich inner` in `durable-enrich`)

[View trace in Dash0](https://app.dash0.com/goto/traces/explorer?dataset=default&from=now-30m&to=now&trace_id=6a410bd8697c623910a1cd6120199dba)

### Root cause hypothesis

`durable.operation.id` is computed as a hash of the step's sequential index within the
handler (e.g. MD5 or similar of the integer `0`, `1`, `2`, ...). It is not scoped to the
function ARN, function name, or execution ARN. Since both `validate` and `enrich` are index 0
in their respective handlers, they produce the same hash `c4ca4238a0b92382`.

The fix would be to include a function-scoped seed in the hash input — e.g.
`hash(functionName + ":" + stepIndex)` or `hash(executionArn + ":" + stepIndex)` — ensuring
`op.id` values are unique across different functions.

### Related observations

- The `durable.operation.id` for `validate` (`c4ca4238`) is identical to the `op.id` for
  `enrich` in the child function, confirming the position-only hashing scheme.
- `process` (step 2) has `op.id = c81e728d9d4c2f63`, and `notify` (step 4) has
  `op.id = e4da3b7fbbce2345` — consistent with sequential MD5 hashing of integers.
- The MD5 hashes of integers 0, 1, 2, 3 are:
  - `0` → `cfcd208495d565ef66e7dff9f98764da`
  - `1` → `c4ca4238a0b923820dcc509a6f75849b` ← matches `validate` / `enrich` op.id prefix
  - `2` → `c81e728d9d4c2f636f067f89cc14862c` ← matches `process` op.id prefix
  - `4` → `1679091c5a880faf6fb5e6087eb1b2dc`
  This confirms op.id is `MD5(stepIndex)` truncated to 16 hex chars.
