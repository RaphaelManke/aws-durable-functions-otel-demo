import { withDurableExecution, DurableContext } from '@aws/durable-execution-sdk-js';
import { DurableExecutionOtelPlugin } from '@aws/durable-execution-sdk-js-otel';

interface ChainWaitEvent {
  input: string;
}

const handler = withDurableExecution(
  async (event: ChainWaitEvent, context: DurableContext) => {
    context.logger.info(JSON.stringify({ xray_trace_id: process.env._X_AMZN_TRACE_ID ?? null }));

    const step1Result = await context.step('step-one', async () => {
      return { value: `${event.input}-one`, ts: new Date().toISOString() };
    });

    const step2Result = await context.step('step-two', async () => {
      return { value: `${step1Result.value}-two`, ts: new Date().toISOString() };
    });

    await context.wait('pause', { seconds: 2 });

    const step3Result = await context.step('step-three', async () => {
      return { value: `${step2Result.value}-three`, ts: new Date().toISOString() };
    });

    return { success: true, result: step3Result.value };
  },
  { plugins: [new DurableExecutionOtelPlugin()] },
);

module.exports = { handler };
