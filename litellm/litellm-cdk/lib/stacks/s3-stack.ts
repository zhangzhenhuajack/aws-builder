import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { S3StackProps } from '../interfaces/stack-props';

export class S3Stack extends cdk.Stack {
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: S3StackProps) {
    super(scope, id, props);

    const { config } = props;

    // Create S3 bucket with security best practices
    this.bucket = new s3.Bucket(this, 'LiteLLMBucket', {
      bucketName: `litellm-${config.environmentName}-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      bucketKeyEnabled: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: 'IntelligentTiering',
          enabled: true,
          transitions: [
            {
              transitionAfter: cdk.Duration.days(0),
              storageClass: s3.StorageClass.INTELLIGENT_TIERING,
            },
          ],
        },
      ],
    });

    // Bucket policy: enforce HTTPS (deny s3:* when aws:SecureTransport is false)
    this.bucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'DenyInsecureTransport',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:*'],
      resources: [this.bucket.bucketArn, `${this.bucket.bucketArn}/*`],
      conditions: { Bool: { 'aws:SecureTransport': 'false' } },
    }));
  }
}
