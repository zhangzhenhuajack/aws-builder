#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AppConfig } from '../lib/interfaces/stack-props';
import { VpcStack } from '../lib/stacks/vpc-stack';
import { S3Stack } from '../lib/stacks/s3-stack';
import { DatabaseStack } from '../lib/stacks/database-stack';
import { BedrockStack } from '../lib/stacks/bedrock-stack';
import { EcsStack } from '../lib/stacks/ecs-stack';
import { CloudFrontStack } from '../lib/stacks/cloudfront-stack';

/**
 * Load configuration from CDK Context with defaults matching cdk.json context values.
 */
function loadConfig(app: cdk.App): AppConfig {
  const cpuArch = (app.node.tryGetContext('cpuArchitecture') as string | undefined) ?? 'ARM64';
  if (cpuArch !== 'ARM64' && cpuArch !== 'X86_64') {
    throw new Error(`Invalid cpuArchitecture context value: ${cpuArch}. Must be 'ARM64' or 'X86_64'.`);
  }

  return {
    environmentName: app.node.tryGetContext('environmentName') || 'litellm',
    vpcCidr: app.node.tryGetContext('vpcCidr') || '10.0.0.0/16',
    auroraMinAcu: app.node.tryGetContext('auroraMinAcu') ?? 0.5,
    auroraMaxAcu: app.node.tryGetContext('auroraMaxAcu') ?? 8,
    redisMaxMemory: app.node.tryGetContext('redisMaxMemory') ?? 5,
    redisMaxEcpu: app.node.tryGetContext('redisMaxEcpu') ?? 15000,
    litellmImage: app.node.tryGetContext('litellmImage') || 'docker.litellm.ai/berriai/litellm:v1.89.0',
    cpuArchitecture: cpuArch,
    taskCpu: app.node.tryGetContext('taskCpu') ?? 2048,
    taskMemory: app.node.tryGetContext('taskMemory') ?? 4096,
    desiredCount: app.node.tryGetContext('desiredCount') ?? 2,
    domainName: app.node.tryGetContext('domainName') || undefined,
    certificateArn: app.node.tryGetContext('certificateArn') || undefined,
    rateLimitPerIp: app.node.tryGetContext('rateLimitPerIp') ?? 2000,
  };
}

const app = new cdk.App();
const config = loadConfig(app);

// Instantiate stacks in dependency order
const vpcStack = new VpcStack(app, 'LitellmVpcStack', { config });

const s3Stack = new S3Stack(app, 'LitellmS3Stack', { config });

const databaseStack = new DatabaseStack(app, 'LitellmDatabaseStack', {
  config,
  vpc: vpcStack.vpc,
  privateSubnets: vpcStack.privateSubnets,
});

const bedrockStack = new BedrockStack(app, 'LitellmBedrockStack', { config });

const ecsStack = new EcsStack(app, 'LitellmEcsStack', {
  config,
  vpc: vpcStack.vpc,
  privateSubnets: vpcStack.privateSubnets,
  bucket: s3Stack.bucket,
  auroraCluster: databaseStack.auroraCluster,
  auroraSecret: databaseStack.auroraSecret,
  redisEndpoint: databaseStack.redisEndpoint,
  redisPort: databaseStack.redisPort,
  dynamoTable: databaseStack.dynamoTable,
  bedrockPolicy: bedrockStack.bedrockPolicy,
});

const cloudfrontStack = new CloudFrontStack(app, 'LitellmCloudFrontStack', {
  config,
  albArn: ecsStack.alb.loadBalancerArn,
  albDnsName: ecsStack.alb.loadBalancerDnsName,
});

app.synth();
