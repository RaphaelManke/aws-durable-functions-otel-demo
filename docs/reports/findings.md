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

### Full span + link map (trace `6a410bd8697c623910a1cd6120199dba`)

Spans are shown with their span ID and link targets. `──link──►` denotes an OTel span link
(not a parent-child relationship). `└─` denotes parent-child.

```
INVOCATION 1  (durable-workflow, cold start)
─────────────────────────────────────────────────────────────────────────────
53957874840f7a9e  durable-workflow [SERVER]
└─ 407019c5d9e711f5  handler
   └─ 55517f58490209e2  invocation  [durable.execution.arn=5b5595a2]
      │
      ├─ 026806110351f2bf  validate (outer) [STEP op.id=c4ca4238]  links:2
      │  │  ──link──► 026806110351f2bf (self? prior replay — none on first run)
      │  │  ──link──► 7442731d2c090cdd (validate inner, same invocation)
      │  └─ 7442731d2c090cdd  validate (inner) [STEP op.id=c4ca4238]  links:1
      │        ──link──► (no prior step — this is step #1, link target is absent/null)
      │
      ├─ 8584d6284f99747f  Lambda.Checkpoint  links:0
      │  └─ c3609a12da88caac  POST /durable-executions/...  links:0
      │
      ├─ 20bb507a4917096c  process (outer) [STEP op.id=c81e728d]  links:1
      │  │  ──link──► 7442731d2c090cdd  (validate inner)  ✓ correct
      │  └─ 2bf0e6c543559d2d  process (inner) [STEP op.id=c81e728d]  links:1
      │        ──link──► 7442731d2c090cdd  (validate inner)  ✓ correct
      │
      ├─ 53ddecf8b4149425  Lambda.Checkpoint  links:0
      │  └─ bda346b407ebe41c  POST  links:0
      │
      ├─ 6c801fad4f559848  Lambda.Checkpoint  links:0
      │  └─ 0cbe545ef2ad4b62  POST  links:0
      │
      └─ 6f473045cd95e6f6  cooldown [WAIT op.id=eccbc87e]  links:0
                                                            ⚠ no link to resume invocation


INVOCATION 2  (durable-workflow)
─────────────────────────────────────────────────────────────────────────────
106f1ca168045122  durable-workflow [SERVER]           ⚠ root — no link from invocation 1
└─ 04c56ff520df33ad  handler
   └─ 400bc30e8a79737c  invocation  [durable.execution.arn=5b5595a2]
      │
      ├─ 6d0bf87c11229c1f  Lambda.Checkpoint  links:0
      │  └─ 4849dc6835d092d9  POST  links:0
      │
      └─ d18f36efef0de843  enrich-user [CHAINED_INVOKE op.id=a87ff679]  links:0
                                                    ⚠ no link to durable-enrich SERVER span


CHILD FUNCTION  (durable-enrich, cold start, same traceId)
─────────────────────────────────────────────────────────────────────────────
5cbb216c71b8352e  durable-enrich [SERVER]             ⚠ root — no parent link from enrich-user
├─ f5dad802de5ded8d  aws.lambda.initialization (1061ms)
└─ a5d1534b3c256b67  handler  [faas.coldstart=true]
   └─ 24da70afaab772c4  invocation  [durable.execution.arn=39a22573]
      │
      ├─ 026806110351f2bf  enrich (outer) [STEP op.id=c4ca4238]  links:0
      │                                           ⚠ same op.id as validate in durable-workflow!
      │  └─ 004e261792dcf157  enrich (inner) [STEP op.id=c4ca4238]  links:1
      │        ──link──► 7442731d2c090cdd  (validate inner in durable-workflow!)
      │                           ⚠ WRONG: cross-function link due to op.id collision
      │
      ├─ 09cb8b8c81083223  Lambda.Checkpoint  links:0
      │  └─ 96123c3d25eee265  POST (637ms)  links:0
      │
      └─ [no link back to enrich-user in durable-workflow]


INVOCATION 3  (durable-workflow)
─────────────────────────────────────────────────────────────────────────────
4b3b152565c4c52b  durable-workflow [SERVER]           ⚠ root — no link from invocation 2
└─ 6e1e4627c78a7938  handler
   └─ b61672b08762498f  invocation  [durable.execution.arn=5b5595a2]
      │
      ├─ e898c59e6496bdbe  Lambda.Checkpoint  links:0
      │  └─ 9947fe2afb2b900d  POST  links:0
      │
      └─ 3543fdec00c92c8d  notify (outer) [STEP op.id=e4da3b7f]  links:1
         │  ──link──► 004e261792dcf157  (enrich inner in durable-enrich)
         │                     ⚠ WRONG: should link to process inner (2bf0e6c543559d2d)
         │                       but op.id collision causes it to land on enrich (child fn)
         └─ 3f97b32cd922cfed  notify (inner) [STEP op.id=e4da3b7f]  links:1
               ──link──► 004e261792dcf157  (enrich inner in durable-enrich)
                                   ⚠ WRONG: same cross-function collision
```

### Link chain — actual vs expected

```
ACTUAL (broken):
  notify inner  3f97b32cd922cfed
       ──link──► enrich inner  004e261792dcf157  (durable-enrich, step #1)
                      ──link──► validate inner  7442731d2c090cdd  (durable-workflow, step #1)
                                      ──link──► (null — step #1 has no prior step)

EXPECTED (correct):
  notify inner  3f97b32cd922cfed
       ──link──► process inner  2bf0e6c543559d2d  (durable-workflow, step #2)
                      ──link──► validate inner  7442731d2c090cdd  (durable-workflow, step #1)
                                      ──link──► (null — step #1 has no prior step)
```

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
