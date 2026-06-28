# Lambda Durable Function with OTel + Dash0

CDK TypeScript app deploying a durable function workflow with OpenTelemetry tracing, forwarding X-Ray spans to Dash0 via Firehose.

## Prerequisites

### Create the Dash0 API key parameter

The stack reads the Dash0 auth token from SSM Parameter Store. Create the parameter before deploying:

```bash
aws ssm put-parameter \
  --name "/lambda-durable-otel/dash0-api-key" \
  --type "String" \
  --value "YOUR_DASH0_API_KEY" \
  --profile otel-playground \
  --region eu-central-1
```

To update the value later:

```bash
aws ssm put-parameter \
  --name "/lambda-durable-otel/dash0-api-key" \
  --type "String" \
  --value "NEW_DASH0_API_KEY" \
  --overwrite \
  --profile otel-playground \
  --region eu-central-1
```

## Commands

```bash
npm run synth         # Synthesize CloudFormation template
npm run diff          # Compare deployed stack with current state
npm run deploy        # Deploy stack (no approval prompt)
npm run destroy       # Tear down stack
npm run workflow-viz  # Generate workflow diagrams and docs → WORKFLOWS.md
```

## Workflows

See [WORKFLOWS.md](./WORKFLOWS.md) for documented workflow diagrams with input/output types.
