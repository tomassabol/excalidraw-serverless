import { Logger } from '@aws-lambda-powertools/logger';
import { search } from '@aws-lambda-powertools/logger/correlationId';
import { Metrics } from '@aws-lambda-powertools/metrics';
import { Tracer } from '@aws-lambda-powertools/tracer';

// Service name and metrics namespace come from POWERTOOLS_SERVICE_NAME and
// POWERTOOLS_METRICS_NAMESPACE, set on each function in CDK.
// `search` lets injectLambdaContext resolve the correlation ID path
export const logger = new Logger({ correlationIdSearchFn: search });
export const tracer = new Tracer();
export const metrics = new Metrics();
