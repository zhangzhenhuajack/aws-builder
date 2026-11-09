import { Annotations, CfnOutput, Duration, RemovalPolicy, Size, Stack, StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as ga from 'aws-cdk-lib/aws-globalaccelerator';
import * as gaEndpoints from 'aws-cdk-lib/aws-globalaccelerator-endpoints';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubs from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import { NewApiConfig, albIsInternetFacing, httpsEnabled } from './config';
import { acknowledge } from './nag';
import { WafAllowlistAcl } from './waf';

export interface AppStackProps extends StackProps {
  readonly config: NewApiConfig;
  readonly vpc: ec2.IVpc;
  readonly albSg: ec2.ISecurityGroup;
  readonly appSg: ec2.ISecurityGroup;
  readonly dbCluster: rds.IDatabaseCluster;
  readonly dbSecret: secretsmanager.ISecret;
  readonly dbName: string;
  readonly cacheSecret: secretsmanager.ISecret;
  readonly cacheEndpointAddress: string;
  readonly cacheEndpointPort: string;
  readonly sessionSecret: secretsmanager.ISecret;
  readonly cryptoSecret: secretsmanager.ISecret;
  /** Data 栈 CMK ARN（用于授权执行角色解密密钥） */
  readonly dataKeyArn: string;
}

const CONTAINER_PORT = 3000;

/**
 * 启动脚本：用 Secrets Manager 注入的分量拼接连接串，再 exec new-api。
 * 密码仅含字母数字与 -_.~（见 data-stack.ts），无需 URL 编码。
 */
const ENTRYPOINT_SCRIPT = [
  // 注意：不使用 ${VAR} 写法，避免与 CloudFormation Fn::Sub 语法混淆
  'set -eu',
  'export SQL_DSN="postgresql://$DB_USERNAME:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME?sslmode=require"',
  'export REDIS_CONN_STRING="rediss://$REDIS_USERNAME:$REDIS_PASSWORD@$REDIS_HOST:$REDIS_PORT"',
  'export NODE_NAME="$NODE_ROLE-$(cat /proc/sys/kernel/hostname)"',
  'unset DB_PASSWORD REDIS_PASSWORD',
  'mkdir -p /data/logs',
  'exec /new-api --log-dir /data/logs',
].join('\n');

/**
 * 应用层：ECS Fargate（master + worker）、ALB、WAF、Global Accelerator（可选）、DNS/证书、告警。
 */
export class AppStack extends Stack {
  /** 供安全托底栈使用 */
  public readonly albFullName: string;
  public readonly webAclName: string;
  public readonly appLogGroupName: string;

  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);
    const cfg = props.config;
    const tls = httpsEnabled(cfg);
    const internetFacing = albIsInternetFacing(cfg);

    if (!tls) {
      Annotations.of(this).addWarningV2(
        'newapi:no-tls',
        'domainName + (hostedZoneId | certificateArn) not set: ALB only listens on HTTP:80. ' +
          'Global Accelerator is a TCP pass-through, so traffic is NOT encrypted. Do not use for production.',
      );
    }
    if (!cfg.enableAga && !internetFacing) {
      Annotations.of(this).addWarningV2(
        'newapi:private-only',
        'AGA disabled and albScheme=internal: the service is reachable only from inside the VPC (or via VPN/DX/peering).',
      );
      acknowledge(this, [{ id: 'Annotation::newapi:private-only', reason: 'Private-only access explicitly chosen via albScheme=internal.' }]);
    }

    // ---------------------------------------------------------------
    // KMS（日志 / SNS）
    // ---------------------------------------------------------------
    const appKey = new kms.Key(this, 'AppKey', {
      description: `${cfg.prefix} app encryption key (logs / SNS)`,
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    appKey.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
        actions: ['kms:Encrypt*', 'kms:Decrypt*', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:Describe*'],
        resources: ['*'],
        conditions: {
          ArnLike: { 'kms:EncryptionContext:aws:logs:arn': `arn:${this.partition}:logs:${this.region}:${this.account}:*` },
        },
      }),
    );
    appKey.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
        actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
        resources: ['*'],
      }),
    );

    // ---------------------------------------------------------------
    // ECS Cluster / Task
    // ---------------------------------------------------------------
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: props.vpc,
      clusterName: `${cfg.prefix}-cluster`,
      containerInsightsV2: ecs.ContainerInsights.ENHANCED,
      executeCommandConfiguration: cfg.enableExecuteCommand
        ? { kmsKey: appKey, logging: ecs.ExecuteCommandLogging.DEFAULT }
        : undefined,
    });

    const logGroup = new logs.LogGroup(this, 'AppLogGroup', {
      logGroupName: `/ecs/${cfg.prefix}/new-api`,
      retention: cfg.logRetentionDays as logs.RetentionDays,
      encryptionKey: appKey,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const imageCredentials = cfg.imageRepositoryCredentialsSecretArn
      ? secretsmanager.Secret.fromSecretCompleteArn(this, 'ImageCredentials', cfg.imageRepositoryCredentialsSecretArn)
      : undefined;
    const image = ecs.ContainerImage.fromRegistry(cfg.image, imageCredentials ? { credentials: imageCredentials } : undefined);

    const executionRole = new iam.Role(this, 'TaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'new-api task execution role (pull image, write logs, read secrets)',
    });
    // 应用本身不调用 AWS API，task role 不授予任何业务权限
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'new-api task role (no AWS permissions by default)',
    });

    // 以 ARN 方式导入 Data 栈的密钥（不携带 KMS key 对象），授权只落在本栈的 IAM 策略里
    const importSecret = (id: string, s: secretsmanager.ISecret) =>
      secretsmanager.Secret.fromSecretCompleteArn(this, id, s.secretArn);
    const dbSecret = importSecret('DbSecretRef', props.dbSecret);
    const cacheSecret = importSecret('CacheSecretRef', props.cacheSecret);
    const sessionSecret = importSecret('SessionSecretRef', props.sessionSecret);
    const cryptoSecret = importSecret('CryptoSecretRef', props.cryptoSecret);

    const baseEnv: Record<string, string> = {
      DB_HOST: props.dbCluster.clusterEndpoint.hostname,
      DB_PORT: props.dbCluster.clusterEndpoint.port.toString(),
      DB_NAME: props.dbName,
      REDIS_HOST: props.cacheEndpointAddress,
      REDIS_PORT: props.cacheEndpointPort,
      TZ: cfg.timezone,
      ERROR_LOG_ENABLED: 'true',
      BATCH_UPDATE_ENABLED: 'true',
      MEMORY_CACHE_ENABLED: 'true',
      SYNC_FREQUENCY: '60',
      STREAMING_TIMEOUT: String(cfg.streamingTimeoutSeconds),
      SHUTDOWN_TIMEOUT_SECONDS: '110',
      // 只信任 VPC 内（ALB）设置的 X-Forwarded-For，防止客户端伪造 IP
      TRUSTED_PROXIES: props.vpc.vpcCidrBlock,
      ...(tls && cfg.domainName
        ? { SESSION_COOKIE_SECURE: 'true', SESSION_COOKIE_TRUSTED_URL: `https://${cfg.domainName}` }
        : {}),
      ...cfg.extraEnvironment,
    };

    const secrets: Record<string, ecs.Secret> = {
      DB_USERNAME: ecs.Secret.fromSecretsManager(dbSecret, 'username'),
      DB_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, 'password'),
      REDIS_USERNAME: ecs.Secret.fromSecretsManager(cacheSecret, 'username'),
      REDIS_PASSWORD: ecs.Secret.fromSecretsManager(cacheSecret, 'password'),
      SESSION_SECRET: ecs.Secret.fromSecretsManager(sessionSecret),
      CRYPTO_SECRET: ecs.Secret.fromSecretsManager(cryptoSecret),
    };
    // 密钥由 Data 栈的 CMK 加密：用身份策略授权解密（限定经 Secrets Manager 调用），
    // 避免修改 Data 栈的 key policy 造成跨栈循环依赖
    executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt'],
        resources: [props.dataKeyArn],
        conditions: { StringEquals: { 'kms:ViaService': `secretsmanager.${this.region}.amazonaws.com` } },
      }),
    );

    const makeTaskDef = (role: 'master' | 'worker'): ecs.FargateTaskDefinition => {
      const td = new ecs.FargateTaskDefinition(this, `${role === 'master' ? 'Master' : 'Worker'}TaskDef`, {
        family: `${cfg.prefix}-${role}`,
        cpu: cfg.taskCpu,
        memoryLimitMiB: cfg.taskMemoryMiB,
        runtimePlatform: {
          cpuArchitecture: cfg.cpuArchitecture === 'ARM64' ? ecs.CpuArchitecture.ARM64 : ecs.CpuArchitecture.X86_64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
        executionRole,
        taskRole,
        volumes: [{ name: 'data' }, { name: 'tmp' }],
      });
      const container = td.addContainer('new-api', {
        containerName: 'new-api',
        image,
        essential: true,
        entryPoint: ['/bin/sh', '-c'],
        command: [ENTRYPOINT_SCRIPT],
        environment: {
          ...baseEnv,
          NODE_ROLE: role,
          // 官方多机部署：仅一个 master 负责迁移/定时任务，其余节点 NODE_TYPE=slave
          ...(role === 'worker' ? { NODE_TYPE: 'slave' } : {}),
        },
        secrets,
        portMappings: [{ containerPort: CONTAINER_PORT, protocol: ecs.Protocol.TCP, name: 'http' }],
        readonlyRootFilesystem: cfg.readonlyRootFilesystem,
        linuxParameters: new ecs.LinuxParameters(this, `${role}LinuxParams`, { initProcessEnabled: true }),
        stopTimeout: Duration.seconds(120),
        healthCheck: {
          command: ['CMD-SHELL', `wget -q -O /dev/null http://127.0.0.1:${CONTAINER_PORT}/api/status || exit 1`],
          interval: Duration.seconds(30),
          timeout: Duration.seconds(10),
          retries: 3,
          startPeriod: Duration.seconds(90),
        },
        logging: ecs.LogDrivers.awsLogs({
          logGroup,
          streamPrefix: role,
          mode: ecs.AwsLogDriverMode.NON_BLOCKING,
          maxBufferSize: cdkSize(25),
        }),
      });
      container.addMountPoints(
        { sourceVolume: 'data', containerPath: '/data', readOnly: false },
        { sourceVolume: 'tmp', containerPath: '/tmp', readOnly: false },
      );
      return td;
    };

    const masterTd = makeTaskDef('master');
    const workerTd = makeTaskDef('worker');

    // ---------------------------------------------------------------
    // ALB（AGA 开启时为 internal；关闭时为 internet-facing，可用 albScheme 覆盖）
    // ---------------------------------------------------------------
    const accessLogBucket = new s3.Bucket(this, 'AlbAccessLogs', {
      encryption: s3.BucketEncryption.S3_MANAGED, // ALB 访问日志仅支持 SSE-S3
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      versioned: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      lifecycleRules: [
        { id: 'expire', expiration: Duration.days(365), noncurrentVersionExpiration: Duration.days(30) },
        { id: 'abort-mpu', abortIncompleteMultipartUploadAfter: Duration.days(7) },
      ],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: props.vpc,
      internetFacing,
      vpcSubnets: internetFacing ? { subnetType: ec2.SubnetType.PUBLIC } : { subnetGroupName: 'app' },
      securityGroup: props.albSg,
      idleTimeout: Duration.seconds(cfg.albIdleTimeoutSeconds),
      clientKeepAlive: Duration.seconds(3600),
      dropInvalidHeaderFields: true,
      desyncMitigationMode: elbv2.DesyncMitigationMode.DEFENSIVE,
      http2Enabled: true,
      deletionProtection: cfg.albDeletionProtection,
    });
    alb.logAccessLogs(accessLogBucket, 'alb');

    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      vpc: props.vpc,
      port: CONTAINER_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      // 流式（SSE）长连接：给在途请求足够的排空时间
      deregistrationDelay: Duration.seconds(300),
      // /api/status 受 new-api 全局 API 限流（默认每 IP 360 次/180s，计数在 Redis 共享），间隔不宜过短
      healthCheck: {
        path: '/api/status',
        healthyHttpCodes: '200',
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    let certificate: acm.ICertificate | undefined;
    let hostedZone: route53.IHostedZone | undefined;
    if (cfg.hostedZoneId && cfg.hostedZoneName) {
      hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
        hostedZoneId: cfg.hostedZoneId,
        zoneName: cfg.hostedZoneName,
      });
    }
    if (tls) {
      certificate = cfg.certificateArn
        ? acm.Certificate.fromCertificateArn(this, 'Certificate', cfg.certificateArn)
        : new acm.Certificate(this, 'Certificate', {
            domainName: cfg.domainName!,
            validation: acm.CertificateValidation.fromDns(hostedZone),
          });

      alb.addListener('Https', {
        port: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificates: [certificate],
        sslPolicy: elbv2.SslPolicy.TLS13_12_PQ,
        defaultTargetGroups: [targetGroup],
        open: false,
      });
      alb.addListener('HttpRedirect', {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        defaultAction: elbv2.ListenerAction.redirect({ protocol: 'HTTPS', port: '443', permanent: true }),
        open: false,
      });
    } else {
      alb.addListener('Http', {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        defaultTargetGroups: [targetGroup],
        open: false,
      });
    }

    // ---------------------------------------------------------------
    // ECS Services：master ×1（迁移/定时任务） + worker（自动扩缩）
    // ---------------------------------------------------------------
    const serviceCommon = {
      cluster,
      securityGroups: [props.appSg],
      vpcSubnets: { subnetGroupName: 'app' },
      assignPublicIp: false,
      platformVersion: ecs.FargatePlatformVersion.LATEST,
      circuitBreaker: { enable: true, rollback: true },
      enableExecuteCommand: cfg.enableExecuteCommand,
      propagateTags: ecs.PropagatedTagSource.SERVICE,
      healthCheckGracePeriod: Duration.seconds(120),
      maxHealthyPercent: 200,
      minHealthyPercent: 100,
      availabilityZoneRebalancing: ecs.AvailabilityZoneRebalancing.ENABLED,
    };

    const masterService = new ecs.FargateService(this, 'MasterService', {
      ...serviceCommon,
      serviceName: `${cfg.prefix}-master`,
      taskDefinition: masterTd,
      desiredCount: 1,
    });
    masterService.attachToApplicationTargetGroup(targetGroup);

    const workerService = new ecs.FargateService(this, 'WorkerService', {
      ...serviceCommon,
      serviceName: `${cfg.prefix}-worker`,
      taskDefinition: workerTd,
      desiredCount: cfg.workerMinCount,
    });
    workerService.attachToApplicationTargetGroup(targetGroup);
    // 首次部署先让 master 完成数据库迁移再起 worker
    workerService.node.addDependency(masterService);

    const scaling = workerService.autoScaleTaskCount({
      minCapacity: cfg.workerMinCount,
      maxCapacity: cfg.workerMaxCount,
    });
    scaling.scaleOnCpuUtilization('Cpu', {
      targetUtilizationPercent: 60,
      scaleInCooldown: Duration.minutes(5),
      scaleOutCooldown: Duration.minutes(1),
    });
    scaling.scaleOnMemoryUtilization('Memory', {
      targetUtilizationPercent: 75,
      scaleInCooldown: Duration.minutes(5),
      scaleOutCooldown: Duration.minutes(1),
    });

    // ---------------------------------------------------------------
    // WAF（REGIONAL，挂在 ALB 上；AGA 保留客户端 IP，白名单基于真实源 IP）
    // ---------------------------------------------------------------
    const waf = new WafAllowlistAcl(this, 'Waf', {
      prefix: cfg.prefix,
      allowedIpv4Cidrs: cfg.wafAllowedIpv4Cidrs,
      allowedIpv6Cidrs: cfg.wafAllowedIpv6Cidrs,
      rateLimitPer5Min: cfg.wafRateLimitPer5Min,
      logRetentionDays: cfg.logRetentionDays,
      logKey: appKey,
    });
    waf.associate(alb.loadBalancerArn);
    this.albFullName = alb.loadBalancerFullName;
    this.webAclName = waf.webAcl.name!;
    this.appLogGroupName = logGroup.logGroupName;

    // ---------------------------------------------------------------
    // Global Accelerator（可选）
    // ---------------------------------------------------------------
    let accelerator: ga.Accelerator | undefined;
    if (cfg.enableAga) {
      accelerator = new ga.Accelerator(this, 'Accelerator', {
        acceleratorName: `${cfg.prefix}-accelerator`,
        enabled: true,
        ipAddressType: ga.IpAddressType.IPV4,
      });
      const listener = accelerator.addListener('Listener', {
        listenerName: `${cfg.prefix}-tcp`,
        protocol: ga.ConnectionProtocol.TCP,
        portRanges: tls ? [{ fromPort: 80 }, { fromPort: 443 }] : [{ fromPort: 80 }],
        clientAffinity: ga.ClientAffinity.NONE,
      });
      listener.addEndpointGroup('Region', {
        endpoints: [
          new gaEndpoints.ApplicationLoadBalancerEndpoint(alb, {
            weight: 128,
            preserveClientIp: true, // internal ALB 必须保留客户端 IP；WAF 白名单依赖真实源 IP
          }),
        ],
      });
    }

    // ---------------------------------------------------------------
    // DNS（可选：提供 hostedZone 时自动创建 A 记录）
    // ---------------------------------------------------------------
    if (hostedZone && cfg.domainName) {
      const target = accelerator
        ? route53.RecordTarget.fromAlias(new route53Targets.GlobalAcceleratorTarget(accelerator))
        : route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(alb));
      new route53.ARecord(this, 'AliasRecord', {
        zone: hostedZone,
        recordName: cfg.domainName,
        target,
      });
    }

    // ---------------------------------------------------------------
    // 告警（SNS，KMS 加密）
    // ---------------------------------------------------------------
    const topic = new sns.Topic(this, 'AlarmTopic', {
      topicName: `${cfg.prefix}-alarms`,
      masterKey: appKey,
      enforceSSL: true,
    });
    if (cfg.alarmEmail) topic.addSubscription(new snsSubs.EmailSubscription(cfg.alarmEmail));
    const action = new cwActions.SnsAction(topic);

    const alarms: cloudwatch.Alarm[] = [
      alb.metrics
        .httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, { period: Duration.minutes(5), statistic: 'Sum' })
        .createAlarm(this, 'Alb5xx', {
          alarmDescription: 'ALB generated 5xx (no healthy target / timeouts)',
          threshold: 20,
          evaluationPeriods: 1,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        }),
      targetGroup.metrics
        .httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, { period: Duration.minutes(5), statistic: 'Sum' })
        .createAlarm(this, 'Target5xx', {
          alarmDescription: 'new-api returned many 5xx (upstream LLM errors or app failure)',
          threshold: 100,
          evaluationPeriods: 1,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        }),
      targetGroup.metrics.unhealthyHostCount({ period: Duration.minutes(1), statistic: 'Maximum' }).createAlarm(this, 'Unhealthy', {
        alarmDescription: 'Unhealthy new-api targets',
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 3,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      workerService.metricCpuUtilization({ period: Duration.minutes(5) }).createAlarm(this, 'WorkerCpuHigh', {
        alarmDescription: 'Worker CPU high (autoscaling at max?)',
        threshold: 85,
        evaluationPeriods: 3,
      }),
      masterService.metricMemoryUtilization({ period: Duration.minutes(5) }).createAlarm(this, 'MasterMemoryHigh', {
        alarmDescription: 'Master memory high',
        threshold: 85,
        evaluationPeriods: 3,
      }),
      props.dbCluster.metricCPUUtilization({ period: Duration.minutes(5) }).createAlarm(this, 'AuroraCpuHigh', {
        alarmDescription: 'Aurora CPU high',
        threshold: 80,
        evaluationPeriods: 3,
      }),
      new cloudwatch.Metric({
        namespace: 'AWS/RDS',
        metricName: 'ACUUtilization',
        dimensionsMap: { DBClusterIdentifier: props.dbCluster.clusterIdentifier },
        period: Duration.minutes(5),
        statistic: 'Maximum',
      }).createAlarm(this, 'AuroraAcuHigh', {
        alarmDescription: 'Aurora Serverless v2 close to max ACU, consider raising auroraMaxAcu',
        threshold: 90,
        evaluationPeriods: 3,
      }),
    ];
    for (const a of alarms) a.addAlarmAction(action);

    // ---------------------------------------------------------------
    // Outputs
    // ---------------------------------------------------------------
    const scheme = tls ? 'https' : 'http';
    if (accelerator) {
      new CfnOutput(this, 'AcceleratorDnsName', { value: accelerator.dnsName, description: 'Global Accelerator DNS name (CNAME your domain to it, or use the alias record)' });
      new CfnOutput(this, 'AcceleratorUrl', { value: `${scheme}://${accelerator.dnsName}` });
    }
    if (cfg.domainName) {
      new CfnOutput(this, 'ServiceUrl', { value: `${scheme}://${cfg.domainName}` });
      if (!hostedZone) {
        new CfnOutput(this, 'DnsTodo', {
          value: `Create DNS: ${cfg.domainName} CNAME ${accelerator ? accelerator.dnsName : alb.loadBalancerDnsName}`,
        });
      }
    }
    new CfnOutput(this, 'AlbDnsName', { value: alb.loadBalancerDnsName, description: `ALB (${internetFacing ? 'internet-facing' : 'internal'})` });
    new CfnOutput(this, 'WebAclArn', { value: waf.webAcl.attrArn });
    new CfnOutput(this, 'IpAllowlistMode', { value: waf.allowlistEnabled ? 'ENFORCED (non-listed IPs get 403)' : 'OFF (open to all IPs, managed rules + rate limit only)' });
    new CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
    new CfnOutput(this, 'AppLogGroupName', { value: logGroup.logGroupName });
    new CfnOutput(this, 'AlarmTopicArn', { value: topic.topicArn });

    // ---------------------------------------------------------------
    // cdk-nag 确认项（附理由）
    // ---------------------------------------------------------------
    acknowledge(accessLogBucket, [
      {
        id: 'AwsSolutions::AwsSolutions-S1',
        reason: 'This bucket is itself the ALB access-log destination (SSE-S3, TLS-only, versioned, public access blocked).',
      },
    ]);
    acknowledge([masterTd, workerTd], [
      {
        id: 'AwsSolutions::AwsSolutions-ECS2',
        reason: 'Only non-sensitive settings (hosts, ports, flags) are plain environment variables; all credentials come from Secrets Manager.',
      },
    ]);
    if (!tls) {
      acknowledge(this, [{ id: 'Annotation::newapi:no-tls', reason: 'HTTP-only mode explicitly chosen (no domain / certificate configured).' }]);
    }
    if (cfg.enableExecuteCommand) {
      acknowledge(taskRole, [
        {
          id: 'AwsSolutions::AwsSolutions-IAM5[Resource::*]',
          reason: 'ECS Exec requires ssmmessages:Create/OpenControl/DataChannel on "*" (AWS documented). Exec is disabled by default.',
        },
      ]);
    }

  }
}

/** awslogs non-blocking 模式的缓冲大小（MiB） */
function cdkSize(mib: number): Size {
  return Size.mebibytes(mib);
}
