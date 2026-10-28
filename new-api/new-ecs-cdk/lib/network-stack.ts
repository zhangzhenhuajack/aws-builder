import { RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { NewApiConfig } from './config';
import { acknowledge } from './nag';

export interface NetworkStackProps extends StackProps {
  readonly config: NewApiConfig;
}

/**
 * VPC（三层子网）+ 安全组 + VPC 终端节点 + VPC Flow Logs。
 * 所有安全组集中在此栈，避免 App / Data 栈之间出现循环引用。
 */
export class NetworkStack extends Stack {
  public readonly vpc: ec2.Vpc;
  public readonly albSg: ec2.SecurityGroup;
  public readonly appSg: ec2.SecurityGroup;
  public readonly dbSg: ec2.SecurityGroup;
  public readonly cacheSg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);
    const cfg = props.config;

    // ---------------------------------------------------------------
    // VPC: public（NAT/IGW/公网 ALB）| app（ECS、内网 ALB、AGA ENI）| data（Aurora、Valkey，无出网）
    // ---------------------------------------------------------------
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(cfg.vpcCidr),
      ...(cfg.availabilityZones.length ? { availabilityZones: cfg.availabilityZones } : { maxAzs: cfg.maxAzs }),
      natGateways: cfg.natGateways,
      restrictDefaultSecurityGroup: true,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24, mapPublicIpOnLaunch: false },
        { name: 'app', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 20 },
        { name: 'data', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
      gatewayEndpoints: {
        S3: { service: ec2.GatewayVpcEndpointAwsService.S3 },
      },
    });

    // VPC Flow Logs -> CloudWatch Logs（KMS 加密）
    const flowLogKey = new kms.Key(this, 'FlowLogKey', {
      description: `${cfg.prefix} VPC flow logs encryption key`,
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    flowLogKey.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
        actions: ['kms:Encrypt*', 'kms:Decrypt*', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:Describe*'],
        resources: ['*'],
        conditions: {
          ArnLike: { 'kms:EncryptionContext:aws:logs:arn': `arn:${this.partition}:logs:${this.region}:${this.account}:*` },
        },
      }),
    );
    const flowLogGroup = new logs.LogGroup(this, 'FlowLogGroup', {
      retention: cfg.logRetentionDays as logs.RetentionDays,
      encryptionKey: flowLogKey,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.vpc.addFlowLog('FlowLog', {
      destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogGroup),
      trafficType: ec2.FlowLogTrafficType.ALL,
      maxAggregationInterval: ec2.FlowLogMaxAggregationInterval.ONE_MINUTE,
    });

    // ---------------------------------------------------------------
    // Security Groups
    // ---------------------------------------------------------------
    this.albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc: this.vpc,
      description: 'new-api ALB. Internal ALB is reachable only via Global Accelerator ENIs (client IP preserved); IP allowlist enforced by WAF.',
      allowAllOutbound: false,
    });
    // AGA 开启客户端 IP 保留后，到达 ALB 的源地址是真实客户端 IP，因此入站必须放行 0.0.0.0/0；
    // 内网 ALB 没有公网入口，访问控制交给 WAF（IP 白名单 / 托管规则 / 限速）。
    // 80/443 均放行（未启用 TLS 时 443 无监听器）；避免证书开关影响网络栈
    this.albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS from clients (via AGA or internet)');
    this.albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP from clients (redirected to HTTPS when TLS is enabled)');

    this.appSg = new ec2.SecurityGroup(this, 'AppSg', {
      vpc: this.vpc,
      description: 'new-api ECS tasks',
      allowAllOutbound: true, // 需要访问外部 LLM 上游（经 NAT）
    });
    this.appSg.addIngressRule(this.albSg, ec2.Port.tcp(3000), 'From ALB only');
    this.albSg.addEgressRule(this.appSg, ec2.Port.tcp(3000), 'ALB to ECS tasks');

    this.dbSg = new ec2.SecurityGroup(this, 'DbSg', {
      vpc: this.vpc,
      description: 'new-api Aurora PostgreSQL',
      allowAllOutbound: false,
    });
    this.dbSg.addIngressRule(this.appSg, ec2.Port.tcp(5432), 'PostgreSQL from ECS tasks');

    this.cacheSg = new ec2.SecurityGroup(this, 'CacheSg', {
      vpc: this.vpc,
      description: 'new-api ElastiCache Serverless Valkey',
      allowAllOutbound: false,
    });
    // Serverless 缓存：6379 为主端点，6380 为读端点
    this.cacheSg.addIngressRule(this.appSg, ec2.Port.tcpRange(6379, 6380), 'Valkey (TLS) from ECS tasks');

    // ---------------------------------------------------------------
    // Interface VPC Endpoints（PrivateLink）：AWS API 流量不出 VPC、不经 NAT
    // ---------------------------------------------------------------
    if (cfg.enableInterfaceEndpoints) {
      const endpointSg = new ec2.SecurityGroup(this, 'EndpointSg', {
        vpc: this.vpc,
        description: 'Interface VPC endpoints',
        allowAllOutbound: false,
      });
      endpointSg.addIngressRule(this.appSg, ec2.Port.tcp(443), 'HTTPS from ECS tasks');

      const services: Record<string, ec2.InterfaceVpcEndpointAwsService> = {
        SecretsManager: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
        Kms: ec2.InterfaceVpcEndpointAwsService.KMS,
        Logs: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
        EcrApi: ec2.InterfaceVpcEndpointAwsService.ECR,
        EcrDkr: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      };
      for (const [name, service] of Object.entries(services)) {
        this.vpc.addInterfaceEndpoint(`${name}Endpoint`, {
          service,
          privateDnsEnabled: true,
          open: false, // 仅放行 ECS 任务安全组（见上）
          securityGroups: [endpointSg],
          subnets: { subnetGroupName: 'app' },
        });
      }
    }

    acknowledge(this.albSg, [
      {
        id: 'AwsSolutions::AwsSolutions-EC23',
        reason:
          'Global Accelerator preserves the client IP, so the ALB SG must accept 0.0.0.0/0 on 80/443. The internal ALB has no public path ' +
          '(only AGA ENIs can reach it); access control is enforced by AWS WAF (IP allowlist, managed rules, rate limit).',
      },
    ]);

  }
}
