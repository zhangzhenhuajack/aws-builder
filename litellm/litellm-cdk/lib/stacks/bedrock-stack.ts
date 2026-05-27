import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { BedrockStackProps } from '../interfaces/stack-props';

export class BedrockStack extends cdk.Stack {
  public readonly bedrockPolicy: iam.ManagedPolicy;

  constructor(scope: Construct, id: string, props: BedrockStackProps) {
    super(scope, id, props);

    const { config } = props;

    // IAM Managed Policy for Bedrock model invocation
    this.bedrockPolicy = new iam.ManagedPolicy(this, 'BedrockInvokePolicy', {
      managedPolicyName: `${config.environmentName}-bedrock-invoke-policy`,
      description: `Policy for ${config.environmentName} ECS tasks to access Bedrock (full access)`,
      statements: [
        new iam.PolicyStatement({
          sid: 'BedrockFullAccess',
          effect: iam.Effect.ALLOW,
          actions: ['bedrock:*'],
          resources: ['*'],
        }),
      ],
    });
  }
}
