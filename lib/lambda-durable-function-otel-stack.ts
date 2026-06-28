import * as cdk from 'aws-cdk-lib/core';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as logsDestinations from 'aws-cdk-lib/aws-logs-destinations';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import * as path from 'path';

export class LambdaDurableFunctionOtelStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --- OTel instrumentation layer (toggle via: -c otelProvider=dash0|adot) ---
    const otelProvider = "adot"
    // const otelProvider = "dash0"

    const adotLayer = lambda.LayerVersion.fromLayerVersionArn(
      this, 'AdotLayer',
      `arn:aws:lambda:${this.region}:615299751070:layer:AWSOpenTelemetryDistroJs:8`,
    );
    const dash0Layer = lambda.LayerVersion.fromLayerVersionArn(
      this, 'Dash0Layer',
      `arn:aws:lambda:${this.region}:115813213817:layer:dash0-extension-node:11`,
    );

    const otelLayer = otelProvider === 'adot' ? adotLayer : dash0Layer;
    const otelEnv = otelProvider === 'adot'
      ? { AWS_LAMBDA_EXEC_WRAPPER: '/opt/otel-instrument' }
      : {
          AWS_LAMBDA_EXEC_WRAPPER: '/opt/wrapper',
          DASH0_ENDPOINT: 'https://ingress.us-west-2.aws.dash0.com:4318',
          DASH0_TOKEN: ssm.StringParameter.valueForStringParameter(this, '/lambda-durable-otel/dash0-api-key'),
          DASH0_XRAY_TRACES_ENABLED: 'true',
          OTEL_PROPAGATORS: 'tracecontext,baggage,xray,xray-lambda',
        };

    const TRACING_MODE = lambda.Tracing.ACTIVE;
    // --- Child Durable Function (invoked by parent) ---
    const childFn = new NodejsFunction(this, 'ChildFunction', {
      functionName: 'durable-enrich',
      entry: path.join(__dirname, '..', 'lambda-child', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      layers: [otelLayer],
      tracing: TRACING_MODE,
    
      environment: {
        ...otelEnv,
      },
      timeout: cdk.Duration.seconds(30),
      durableConfig: {
        executionTimeout: cdk.Duration.minutes(5),
        retentionPeriod: cdk.Duration.days(3),
      },
    });

    childFn.role!.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicDurableExecutionRolePolicy'),
    );
    childFn.role!.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AWSXRayDaemonWriteAccess'),
    );

    // --- Parent Durable Function ---
    const fn = new NodejsFunction(this, 'DurableFunction', {
      functionName: 'durable-workflow',
      entry: path.join(__dirname, '..', 'lambda', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      layers: [otelLayer],
      tracing: TRACING_MODE,
      environment: {
        ...otelEnv,
        CHILD_FUNCTION_ARN: childFn.functionArn + ':$LATEST',
      },
      timeout: cdk.Duration.seconds(30),
      durableConfig: {
        executionTimeout: cdk.Duration.hours(1),
        retentionPeriod: cdk.Duration.days(3),
      },
    });

    fn.role!.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicDurableExecutionRolePolicy'),
    );
    fn.role!.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AWSXRayDaemonWriteAccess'),
    );

    // Grant parent permission to invoke child
    childFn.grantInvoke(fn);

    const alias = new lambda.Alias(this, 'LiveAlias', {
      aliasName: 'live',
      version: fn.currentVersion,
    });

    new cdk.CfnOutput(this, 'FunctionAliasArn', { value: alias.functionArn });
    new cdk.CfnOutput(this, 'ChildFunctionArn', { value: childFn.functionArn });

    // --- Chain Durable Function (pure 3-step chain, no invokes or waits) ---
    const chainFn = new NodejsFunction(this, 'ChainFunction', {
      functionName: 'durable-chain',
      entry: path.join(__dirname, '..', 'lambda-chain', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      layers: [otelLayer],
      tracing: TRACING_MODE,
      environment: {
        ...otelEnv,
      },
      timeout: cdk.Duration.seconds(30),
      durableConfig: {
        executionTimeout: cdk.Duration.minutes(5),
        retentionPeriod: cdk.Duration.days(3),
      },
    });

    chainFn.role!.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicDurableExecutionRolePolicy'),
    );
    chainFn.role!.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AWSXRayDaemonWriteAccess'),
    );

    const chainAlias = new lambda.Alias(this, 'ChainLiveAlias', {
      aliasName: 'live',
      version: chainFn.currentVersion,
    });

    new cdk.CfnOutput(this, 'ChainFunctionAliasArn', { value: chainAlias.functionArn });

    // --- Chain-Wait Durable Function (3 steps with a wait before step 3, tracing=PASS_THROUGH) ---
    const chainWaitFn = new NodejsFunction(this, 'ChainWaitFunction', {
      functionName: 'durable-chain-wait-passthrough',
      entry: path.join(__dirname, '..', 'lambda-chain-wait', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      layers: [otelLayer],
      tracing: TRACING_MODE,
      environment: {
        ...otelEnv,
      },
      timeout: cdk.Duration.seconds(30),
      durableConfig: {
        executionTimeout: cdk.Duration.minutes(5),
        retentionPeriod: cdk.Duration.days(3),
      },
    });

    chainWaitFn.role!.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicDurableExecutionRolePolicy'),
    );
    chainWaitFn.role!.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AWSXRayDaemonWriteAccess'),
    );

    const chainWaitAlias = new lambda.Alias(this, 'ChainWaitLiveAlias', {
      aliasName: 'live',
      version: chainWaitFn.currentVersion,
    });

    new cdk.CfnOutput(this, 'ChainWaitFunctionAliasArn', { value: chainWaitAlias.functionArn });

    // --- Retry Durable Function (step 1 retries on first attempt, step 2 has 10min retry delay) ---
    const retryFn = new NodejsFunction(this, 'RetryFunction', {
      functionName: 'durable-retry',
      entry: path.join(__dirname, '..', 'lambda-retry', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      layers: [otelLayer],
      tracing: TRACING_MODE,
      environment: {
        ...otelEnv,
      },
      timeout: cdk.Duration.seconds(30),
      durableConfig: {
        executionTimeout: cdk.Duration.hours(1),
        retentionPeriod: cdk.Duration.days(3),
      },
    });

    retryFn.role!.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicDurableExecutionRolePolicy'),
    );
    retryFn.role!.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AWSXRayDaemonWriteAccess'),
    );

    const retryAlias = new lambda.Alias(this, 'RetryLiveAlias', {
      aliasName: 'live',
      version: retryFn.currentVersion,
    });

    new cdk.CfnOutput(this, 'RetryFunctionAliasArn', { value: retryAlias.functionArn });
    const dash0Endpoint = 'https://ingress.us-west-2.aws.dash0.com/firehose/cwspans';
    const dash0ApiKey = ssm.StringParameter.valueForStringParameter(
      this, '/lambda-durable-otel/dash0-api-key',
    );

    // S3 bucket for Firehose error backup
    const backupBucket = new s3.Bucket(this, 'FirehoseBackupBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Firehose delivery role
    const firehoseRole = new iam.Role(this, 'FirehoseRole', {
      assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com'),
    });
    backupBucket.grantReadWrite(firehoseRole);

    // Firehose error log group
    const firehoseLogGroup = new logs.LogGroup(this, 'FirehoseLogGroup', {
      logGroupName: '/aws/firehose/dash0-spans-stream',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const firehoseLogStream = new logs.LogStream(this, 'FirehoseLogStream', {
      logGroup: firehoseLogGroup,
      logStreamName: 'HttpEndpointDelivery',
    });
    firehoseLogGroup.grantWrite(firehoseRole);

    // Firehose delivery stream to Dash0 HTTP endpoint
    const deliveryStream = new firehose.CfnDeliveryStream(this, 'Dash0SpansStream', {
      deliveryStreamName: 'dash0-spans-stream',
      httpEndpointDestinationConfiguration: {
        endpointConfiguration: {
          url: dash0Endpoint,
          accessKey: dash0ApiKey,
        },
        requestConfiguration: {
          contentEncoding: 'GZIP',
        },
        bufferingHints: {
          intervalInSeconds: 1,
          sizeInMBs: 1,
        },
        cloudWatchLoggingOptions: {
          enabled: true,
          logGroupName: firehoseLogGroup.logGroupName,
          logStreamName: 'HttpEndpointDelivery',
        },
        s3Configuration: {
          bucketArn: backupBucket.bucketArn,
          roleArn: firehoseRole.roleArn,
          cloudWatchLoggingOptions: {
            enabled: true,
            logGroupName: firehoseLogGroup.logGroupName,
            logStreamName: 'HttpEndpointDelivery',
          },
        },
        roleArn: firehoseRole.roleArn,
      },
    });

    // Import existing aws/spans log group
    const spansLogGroup = logs.LogGroup.fromLogGroupName(this, 'SpansLogGroup', 'aws/spans');

    // IAM role for CloudWatch Logs to put records into Firehose
    const subscriptionRole = new iam.Role(this, 'CWLogsToFirehoseRole', {
      assumedBy: new iam.ServicePrincipal('logs.amazonaws.com'),
      inlinePolicies: {
        FirehosePut: new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            actions: ['firehose:PutRecord', 'firehose:PutRecordBatch'],
            resources: [deliveryStream.attrArn],
          })],
        }),
      },
    });

    // Subscription filter on aws/spans log group
    const subscriptionFilter = new logs.CfnSubscriptionFilter(this, 'SpansSubscriptionFilter', {
      logGroupName: 'aws/spans',
      filterPattern: '',
      destinationArn: deliveryStream.attrArn,
      roleArn: subscriptionRole.roleArn,
    });
    subscriptionFilter.node.addDependency(subscriptionRole);
  }
}
