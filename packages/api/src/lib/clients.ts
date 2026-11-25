import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { tracer } from './powertools.ts';

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable ${name}`);
  }
  return value;
};

export const env = () => ({
  tableName: requireEnv('TABLE_NAME'),
  dataBucket: requireEnv('DATA_BUCKET_NAME'),
  idempotencyTableName: requireEnv('IDEMPOTENCY_TABLE_NAME'),
});

/** AWS SDK clients, instrumented with X-Ray through the Powertools Tracer. */
export const createClients = () => {
  const dynamodb = tracer.captureAWSv3Client(new DynamoDBClient({}));
  const ddb = DynamoDBDocumentClient.from(dynamodb, {
    marshallOptions: { removeUndefinedValues: true },
  });
  const s3 = tracer.captureAWSv3Client(new S3Client({}));
  return { dynamodb, ddb, s3 };
};
