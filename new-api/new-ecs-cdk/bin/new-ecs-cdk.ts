#!/usr/bin/env node
import { App, Tags, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { AppStack } from '../lib/app-stack';
import { loadConfig } from '../lib/config';
import { DataStack } from '../lib/data-stack';
import { NetworkStack } from '../lib/network-stack';
import { SecurityStack } from '../lib/security-stack';

const app = new App();
const cfg = loadConfig(app);

const env = {
  account: process.env.CDK_DEPLOY_ACCOUNT ?? process.env.CDK_DEFAULT_ACCOUNT,
  region: cfg.region,
};

const network = new NetworkStack(app, `${cfg.prefix}-network`, {
  env,
  config: cfg,
  description: 'new-api: VPC, security groups, VPC endpoints, flow logs',
});

const data = new DataStack(app, `${cfg.prefix}-data`, {
  env,
  config: cfg,
  vpc: network.vpc,
  dbSg: network.dbSg,
  cacheSg: network.cacheSg,
  terminationProtection: true,
  description: 'new-api: Aurora PostgreSQL Serverless v2, ElastiCache Serverless Valkey, app secrets',
});

const appStack = new AppStack(app, `${cfg.prefix}-app`, {
  env,
  config: cfg,
  vpc: network.vpc,
  albSg: network.albSg,
  appSg: network.appSg,
  dbCluster: data.dbCluster,
  dbSecret: data.dbSecret,
  dbName: data.dbName,
  cacheSecret: data.cacheSecret,
  cacheEndpointAddress: data.cacheEndpointAddress,
  cacheEndpointPort: data.cacheEndpointPort,
  sessionSecret: data.sessionSecret,
  cryptoSecret: data.cryptoSecret,
  dataKeyArn: data.dataKey.keyArn,
  description: `new-api: ECS Fargate, ALB, WAF${cfg.enableAga ? ', Global Accelerator' : ''}`,
});

if (cfg.enableSecurityBackstop) {
  new SecurityStack(app, `${cfg.prefix}-security`, {
    env,
    config: cfg,
    albFullName: appStack.albFullName,
    webAclName: appStack.webAclName,
    appLogGroupName: appStack.appLogGroupName,
    description: 'new-api: security backstop (invocation audit, alarms, anomaly detection, GuardDuty, cost anomaly)',
  });
}

Tags.of(app).add('Project', 'new-api');
Tags.of(app).add('Environment', cfg.prefix);
Tags.of(app).add('ManagedBy', 'CDK');

// 合规检查：cdk-nag AWS Solutions 规则集（未确认的违规会让 synth 失败）
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
