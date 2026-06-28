# Agent Context — Lambda Durable Function (OTel Playground)

## Project Overview

AWS CDK TypeScript app deploying a Lambda durable function with a simple multi-step workflow (validate → process → notify). Uses `tsx` for direct TS execution (no compilation step), `esbuild` for Lambda bundling, and deploys via the `otel-playground` AWS profile.

## Relevant Installed Skills

| Skill | When to use |
|-------|-------------|
| **aws-lambda-durable-functions** | Primary skill. Replay model rules, step operations, wait/callback patterns, error handling, testing with LocalDurableTestRunner, deployment patterns. |
| **aws-cdk** | CDK construct authoring, deployment workflows, troubleshooting synth/deploy errors, bootstrap, refactoring stacks safely. |
| **aws-serverless** | Lambda configuration (cold starts, memory, layers), concurrency, event source mappings, API Gateway, production readiness. |
| **aws-iam** | IAM policy evaluation edge cases, trust policies, STS sessions. Relevant for the durable execution role policy. |
| **aws-observability** | CloudWatch Logs Insights queries, alarms, dashboards, X-Ray tracing. Useful for monitoring durable function executions. |

## Key Commands

```bash
npm run synth     # Synthesize CloudFormation template
npm run diff      # Compare deployed stack with current state
npm run deploy    # Deploy stack (no approval prompt)
npm run destroy   # Tear down stack
```

## Durable Function Essentials

- Handler uses `withDurableExecution` wrapper
- All non-deterministic code must be inside `context.step()`
- Invoke with qualified ARN (version, alias, or `$LATEST`)
- Requires `AWSLambdaBasicDurableExecutionRolePolicy` on execution role
