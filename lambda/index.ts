import { withDurableExecution, DurableContext } from '@aws/durable-execution-sdk-js';
import { DurableExecutionOtelPlugin } from '@aws/durable-execution-sdk-js-otel';

interface WorkflowEvent {
  name: string;
  email?: string;
}

const handler = withDurableExecution(
  async (event: WorkflowEvent, context: DurableContext) => {
    context.logger.info(JSON.stringify({ xray_trace_id: process.env._X_AMZN_TRACE_ID ?? null }));

    const validated = await context.step('validate', async () => {
      if (!event.name) throw new Error('name is required');
      return { name: event.name, email: event.email ?? 'none' };
    });

    const processed = await context.step('process', async () => {
      return { ...validated, processedAt: new Date().toISOString(), id: `usr-${Date.now()}` };
    });

    await context.wait('cooldown', { seconds: 2 });

    const enriched = await context.invoke('enrich-user', process.env.CHILD_FUNCTION_ARN!, {
      userId: processed.id,
      name: processed.name,
    });

    await context.step('notify', async () => {
      context.logger.info('Notification sent', { userId: processed.id, email: processed.email, tier: enriched.tier });
      return { notified: true };
    });

    return { success: true, data: enriched };
  },
  { plugins: [new DurableExecutionOtelPlugin()] },
);

module.exports = { handler };
