import { withDurableExecution, DurableContext, createRetryStrategy, JitterStrategy } from '@aws/durable-execution-sdk-js';
import { DurableExecutionOtelPlugin } from '@aws/durable-execution-sdk-js-otel';

interface RetryEvent {
  input: string;
}

// Module-level counter persists across warm Lambda re-invocations.
// With a 1-second retry delay the container stays warm, so the second
// invocation (retry) of flaky-step will see value=1 and succeed.
const flakyStepAttempt = { value: 0 };

const handler = withDurableExecution(
  async (event: RetryEvent, context: DurableContext) => {
    context.logger.info(JSON.stringify({ xray_trace_id: process.env._X_AMZN_TRACE_ID ?? null }));

    // Step 1: fails on attempt 1, succeeds on attempt 2.
    const step1Result = await context.step(
      'flaky-step',
      async () => {
        flakyStepAttempt.value++;
        context.logger.info(JSON.stringify({ step: 'flaky-step', attempt: flakyStepAttempt.value }));
        if (flakyStepAttempt.value < 2) {
          throw new Error(`flaky-step intentional failure on attempt ${flakyStepAttempt.value}`);
        }
        return { value: `${event.input}-flaky-done`, attempt: flakyStepAttempt.value };
      },
      {
        retryStrategy: createRetryStrategy({
          maxAttempts: 3,
          initialDelay: { seconds: 1 },
          backoffRate: 1,
          jitter: JitterStrategy.NONE,
        }),
      },
    );


    return { success: true, result: step1Result.value };
  },
  { plugins: [new DurableExecutionOtelPlugin()] },
);

module.exports = { handler };
