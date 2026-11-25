import { Logger } from '@aws-lambda-powertools/logger';
import { Metrics } from '@aws-lambda-powertools/metrics';
import { Tracer } from '@aws-lambda-powertools/tracer';

// Service name and metrics namespace come from POWERTOOLS_SERVICE_NAME and
// POWERTOOLS_METRICS_NAMESPACE, set on each function in CDK.
export const logger = new Logger();
export const tracer = new Tracer();
export const metrics = new Metrics();
