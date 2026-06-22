import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';

/** 通用配置接口 */
export interface AppConfig {
  environmentName: string;
  vpcCidr: string;
  auroraMinAcu: number;
  auroraMaxAcu: number;
  redisMaxMemory: number;
  redisMaxEcpu: number;
  litellmImage: string;
  /**
   * Fargate 任务 CPU 架构。
   * - 'ARM64': Graviton,价格/性能更优 (默认)
   * - 'X86_64': Intel/AMD,兼容仅发布 amd64 manifest 的镜像
   */
  cpuArchitecture: 'ARM64' | 'X86_64';
  taskCpu: number;
  taskMemory: number;
  desiredCount: number;
  domainName?: string;
  certificateArn?: string;
  rateLimitPerIp: number;
}

/** VpcStack 输入 */
export interface VpcStackProps extends cdk.StackProps {
  config: AppConfig;
}

/** VpcStack 输出 */
export interface VpcStackOutputs {
  vpc: ec2.IVpc;
  publicSubnets: ec2.ISubnet[];
  privateSubnets: ec2.ISubnet[];
  bedrockEndpointSecurityGroup: ec2.ISecurityGroup;
}

/** S3Stack 输入 */
export interface S3StackProps extends cdk.StackProps {
  config: AppConfig;
}

/** S3Stack 输出 */
export interface S3StackOutputs {
  bucket: s3.IBucket;
}

/** DatabaseStack 输入 */
export interface DatabaseStackProps extends cdk.StackProps {
  config: AppConfig;
  vpc: ec2.IVpc;
  privateSubnets: ec2.ISubnet[];
}

/** DatabaseStack 输出 */
export interface DatabaseStackOutputs {
  auroraCluster: rds.IDatabaseCluster;
  auroraSecret: secretsmanager.ISecret;
  auroraSecurityGroup: ec2.ISecurityGroup;
  redisEndpoint: string;
  redisPort: string;
  redisSecurityGroup: ec2.ISecurityGroup;
  dynamoTable: dynamodb.ITable;
}

/** BedrockStack 输入 */
export interface BedrockStackProps extends cdk.StackProps {
  config: AppConfig;
}

/** BedrockStack 输出 */
export interface BedrockStackOutputs {
  bedrockPolicy: iam.IManagedPolicy;
}

/** EcsStack 输入 */
export interface EcsStackProps extends cdk.StackProps {
  config: AppConfig;
  vpc: ec2.IVpc;
  privateSubnets: ec2.ISubnet[];
  bucket: s3.IBucket;
  auroraCluster: rds.IDatabaseCluster;
  auroraSecret: secretsmanager.ISecret;
  redisEndpoint: string;
  redisPort: string;
  dynamoTable: dynamodb.ITable;
  bedrockPolicy: iam.IManagedPolicy;
}

/** EcsStack 输出 */
export interface EcsStackOutputs {
  alb: elbv2.IApplicationLoadBalancer;
  albSecurityGroup: ec2.ISecurityGroup;
  albDnsName: string;
  albArn: string;
}

/** CloudFrontStack 输入 */
export interface CloudFrontStackProps extends cdk.StackProps {
  config: AppConfig;
  albArn: string;
  albDnsName: string;
}
