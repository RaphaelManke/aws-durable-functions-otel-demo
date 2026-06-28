import { withDurableExecution, DurableContext } from '@aws/durable-execution-sdk-js';
import { DurableExecutionOtelPlugin } from '@aws/durable-execution-sdk-js-otel';

interface EnrichEvent {
  userId: string;
  name: string;
}

const handler = withDurableExecution(
  async (event: EnrichEvent, context: DurableContext) => {
    context.logger.info(JSON.stringify({ xray_trace_id: process.env._X_AMZN_TRACE_ID ?? null }));

    const enriched = await context.step('enrich', async () => {
      return { ...event, tier: 'premium', enrichedAt: new Date().toISOString() };
    });

    return enriched;
  },
  { plugins: [new DurableExecutionOtelPlugin()] },
);

module.exports = { handler };
