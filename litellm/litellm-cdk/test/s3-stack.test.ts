import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { S3Stack } from '../lib/stacks/s3-stack';
import { AppConfig } from '../lib/interfaces/stack-props';

describe('S3Stack', () => {
  let template: Template;
  const config: AppConfig = {
    environmentName: 'test',
    vpcCidr: '10.0.0.0/16',
    auroraMinAcu: 0.5,
    auroraMaxAcu: 8,
    redisMaxMemory: 5,
    redisMaxEcpu: 15000,
    litellmImage: 'ghcr.io/berriai/litellm:latest',
    taskCpu: 2048,
    taskMemory: 4096,
    desiredCount: 2,
    rateLimitPerIp: 2000,
  };

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new S3Stack(app, 'TestS3Stack', { config });
    template = Template.fromStack(stack);
  });

  test('creates S3 bucket with BLOCK_ALL public access', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  test('configures S3-managed encryption with bucket key enabled', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          {
            ServerSideEncryptionByDefault: {
              SSEAlgorithm: 'AES256',
            },
            BucketKeyEnabled: true,
          },
        ],
      },
    });
  });

  test('enables versioning', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: {
        Status: 'Enabled',
      },
    });
  });

  test('configures Intelligent-Tiering lifecycle rule', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: [
          {
            Id: 'IntelligentTiering',
            Status: 'Enabled',
            Transitions: [
              {
                StorageClass: 'INTELLIGENT_TIERING',
                TransitionInDays: 0,
              },
            ],
          },
        ],
      },
    });
  });

  test('sets removal policy to RETAIN', () => {
    template.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
  });

  test('adds bucket policy enforcing HTTPS', () => {
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'DenyInsecureTransport',
            Effect: 'Deny',
            Principal: { AWS: '*' },
            Action: 's3:*',
            Condition: {
              Bool: { 'aws:SecureTransport': 'false' },
            },
          }),
        ]),
      },
    });
  });
});
