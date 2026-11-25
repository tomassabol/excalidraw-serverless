// Runs before any test module is imported, so Powertools picks these up.
process.env.POWERTOOLS_SERVICE_NAME = 'test';
process.env.POWERTOOLS_LOG_LEVEL = 'SILENT';
process.env.POWERTOOLS_TRACE_ENABLED = 'false';
process.env.POWERTOOLS_METRICS_DISABLED = 'true';
process.env.POWERTOOLS_METRICS_NAMESPACE = 'test';
process.env.AWS_REGION = 'eu-central-1';
process.env.AWS_ACCESS_KEY_ID = 'test';
process.env.AWS_SECRET_ACCESS_KEY = 'test';
