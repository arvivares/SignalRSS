import { NodeSDK } from '@opentelemetry/sdk-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { observeOpenAI } from '@langfuse/openai';
import { startObservation } from '@langfuse/tracing';
import { config } from './config.js';

let sdk = null;

export function startLangfuseTracing() {
  const enabled = Boolean(config.langfusePublicKey && config.langfuseSecretKey);
  if (!enabled) return { enabled: false };
  if (sdk) return { enabled: true };

  sdk = new NodeSDK({
    spanProcessors: [new LangfuseSpanProcessor()],
  });
  sdk.start();

  return { enabled: true };
}

export function observeOpenAIClient(openai, metadata = {}, options = {}) {
  if (!sdk) return openai;

  return observeOpenAI(openai, {
    traceName: options.traceName || 'signalrss-classifier',
    metadata: {
      app: 'SignalRSS',
      component: options.component || 'classifier',
      ...metadata,
    },
  });
}

export function startLangfuseGeneration(name, attributes = {}) {
  if (!sdk) return null;

  return startObservation(name, attributes, { asType: 'generation' });
}

export async function shutdownLangfuseTracing() {
  if (!sdk) return;
  await sdk.shutdown();
  sdk = null;
}
