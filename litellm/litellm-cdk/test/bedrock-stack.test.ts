import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { BedrockStack } from '../lib/stacks/bedrock-stack';
import { AppConfig } from '../lib/interfaces/stack-props';

describe('BedrockStack', () => {
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
    const stack = new BedrockStack(app, 'TestBedrockStack', { config });
    template = Template.fromStack(stack);
  });

  test('creates IAM Managed Policy with correct name', () => {
    template.hasResourceProperties('AWS::IAM::ManagedPolicy', {
      ManagedPolicyName: 'test-bedrock-invoke-policy',
    });
  });

  test('grants bedrock:* on all resources', () => {
    template.hasResourceProperties('AWS::IAM::ManagedPolicy', {
      PolicyDocument: {
        Statement: [
          {
            Sid: 'BedrockFullAccess',
            Effect: 'Allow',
            Action: 'bedrock:*',
            Resource: '*',
          },
        ],
      },
    });
  });

  test('exposes bedrockPolicy as public property', () => {
    const app = new cdk.App();
    const stack = new BedrockStack(app, 'TestBedrockStack2', { config });
    expect(stack.bedrockPolicy).toBeDefined();
    expect(stack.bedrockPolicy.managedPolicyArn).toBeDefined();
  });
});
