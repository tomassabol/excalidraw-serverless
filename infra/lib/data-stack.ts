import {
  Duration,
  aws_dynamodb as dynamodb,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_s3 as s3,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';

/**
 * Long-lived data: the main single table and the S3 data bucket.
 * Everything here is retained when the stack is deleted.
 */
export class DataStack extends Stack {
  readonly table: dynamodb.TableV2;
  readonly dataBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.table = new dynamodb.TableV2(this, 'Table', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      // trash expiry; the stream feeds the purge Lambda
      timeToLiveAttribute: 'expiresAt',
      dynamoStream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.dataBucket = new s3.Bucket(this, 'DataBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      lifecycleRules: [{ abortIncompleteMultipartUploadAfter: Duration.days(1) }],
      // The browser uploads/downloads images with presigned URLs. Access is
      // gated by the URL signature, so CORS can allow any origin (this also
      // avoids a dependency on the CloudFront domain in the app stack).
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.HEAD],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
          maxAge: 3600,
        },
      ],
      removalPolicy: RemovalPolicy.RETAIN,
    });
  }
}
