import { Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { NewApiConfig } from './config';
import { acknowledge } from './nag';

export interface DataStackProps extends StackProps {
  readonly config: NewApiConfig;
  readonly vpc: ec2.IVpc;
  readonly dbSg: ec2.ISecurityGroup;
  readonly cacheSg: ec2.ISecurityGroup;
}

// 生成的密码只含字母数字和 URL 非保留字符 -_.~：可直接拼进 postgresql:// 与 rediss:// URL，无需 URL 编码
// （不能排除全部标点：Secrets Manager 要求每类字符至少保留一个）
const URL_UNSAFE_CHARS = ' !"#$%&\'()*+,/:;<=>?@[\\]^`{|}';

/**
 * 有状态资源：Aurora PostgreSQL Serverless v2、ElastiCache Serverless (Valkey)、应用密钥。
 * 启用终止保护，删除策略为 SNAPSHOT / RETAIN。
 */
export class DataStack extends Stack {
  public readonly dataKey: kms.Key;
  public readonly dbCluster: rds.DatabaseCluster;
  public readonly dbSecret: secretsmanager.ISecret;
  public readonly dbName = 'newapi';
  public readonly cacheSecret: secretsmanager.Secret;
  public readonly cacheEndpointAddress: string;
  public readonly cacheEndpointPort: string;
  public readonly cacheName: string;
  public readonly sessionSecret: secretsmanager.Secret;
  public readonly cryptoSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const cfg = props.config;
    const dataSubnets = { subnetGroupName: 'data' };

    this.dataKey = new kms.Key(this, 'DataKey', {
      description: `${cfg.prefix} data encryption key (Aurora / Valkey / Secrets / DB logs)`,
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.dataKey.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
        actions: ['kms:Encrypt*', 'kms:Decrypt*', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:Describe*'],
        resources: ['*'],
        conditions: {
          ArnLike: { 'kms:EncryptionContext:aws:logs:arn': `arn:${this.partition}:logs:${this.region}:${this.account}:*` },
        },
      }),
    );

    // ---------------------------------------------------------------
    // 应用密钥：SESSION_SECRET（多节点会话签名）、CRYPTO_SECRET（数据加密，生成后切勿更改）
    // ---------------------------------------------------------------
    this.sessionSecret = new secretsmanager.Secret(this, 'SessionSecret', {
      secretName: `${cfg.prefix}/new-api/session-secret`,
      description: 'new-api SESSION_SECRET (shared by all nodes)',
      encryptionKey: this.dataKey,
      generateSecretString: { passwordLength: 64, excludeCharacters: URL_UNSAFE_CHARS },
    });
    this.cryptoSecret = new secretsmanager.Secret(this, 'CryptoSecret', {
      secretName: `${cfg.prefix}/new-api/crypto-secret`,
      description: 'new-api CRYPTO_SECRET. DO NOT rotate or delete: data encrypted with it becomes unreadable.',
      encryptionKey: this.dataKey,
      generateSecretString: { passwordLength: 64, excludeCharacters: URL_UNSAFE_CHARS },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ---------------------------------------------------------------
    // Aurora PostgreSQL Serverless v2（writer + reader 跨 AZ）
    // ---------------------------------------------------------------
    const engine = rds.DatabaseClusterEngine.auroraPostgres({
      version: rds.AuroraPostgresEngineVersion.of(cfg.auroraEngineVersion, cfg.auroraEngineVersion.split('.')[0]),
    });

    // 预先创建 PostgreSQL 日志组（KMS 加密 + 保留期），避免 CDK 额外部署 LogRetention Lambda
    const clusterIdentifier = `${cfg.prefix}-aurora`;
    const dbLogGroup = new logs.LogGroup(this, 'AuroraLogGroup', {
      logGroupName: `/aws/rds/cluster/${clusterIdentifier}/postgresql`,
      retention: cfg.logRetentionDays as logs.RetentionDays,
      encryptionKey: this.dataKey,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.dbCluster = new rds.DatabaseCluster(this, 'Aurora', {
      clusterIdentifier,
      engine,
      credentials: rds.Credentials.fromGeneratedSecret('newapi_admin', {
        secretName: `${cfg.prefix}/aurora/master`,
        encryptionKey: this.dataKey,
        excludeCharacters: URL_UNSAFE_CHARS,
      }),
      defaultDatabaseName: this.dbName,
      vpc: props.vpc,
      vpcSubnets: dataSubnets,
      securityGroups: [props.dbSg],
      writer: rds.ClusterInstance.serverlessV2('writer', {
        autoMinorVersionUpgrade: true,
        enablePerformanceInsights: true,
        performanceInsightEncryptionKey: this.dataKey,
        publiclyAccessible: false,
      }),
      readers: [
        rds.ClusterInstance.serverlessV2('reader', {
          scaleWithWriter: true, // 故障切换时 reader 能立即承接写负载
          autoMinorVersionUpgrade: true,
          enablePerformanceInsights: true,
          performanceInsightEncryptionKey: this.dataKey,
          publiclyAccessible: false,
        }),
      ],
      serverlessV2MinCapacity: cfg.auroraMinAcu,
      serverlessV2MaxCapacity: cfg.auroraMaxAcu,
      storageEncrypted: true,
      storageEncryptionKey: this.dataKey,
      iamAuthentication: true,
      deletionProtection: true,
      removalPolicy: RemovalPolicy.SNAPSHOT,
      copyTagsToSnapshot: true,
      backup: { retention: Duration.days(cfg.auroraBackupRetentionDays), preferredWindow: '18:00-19:00' },
      preferredMaintenanceWindow: 'sun:19:30-sun:20:30',
      monitoringInterval: Duration.seconds(60),
      cloudwatchLogsExports: ['postgresql'],
      parameters: {
        'rds.force_ssl': '1', // 强制 TLS 连接
        log_connections: '1',
        log_disconnections: '1',
        log_min_duration_statement: '2000', // 慢 SQL（>2s）
      },
    });

    this.dbSecret = this.dbCluster.secret!;
    this.dbCluster.node.addDependency(dbLogGroup);

    // ---------------------------------------------------------------
    // ElastiCache Serverless (Valkey)：TLS 强制 + RBAC 密码认证 + KMS 加密
    // ---------------------------------------------------------------
    this.cacheSecret = new secretsmanager.Secret(this, 'CacheSecret', {
      secretName: `${cfg.prefix}/valkey/app-user`,
      description: 'new-api ElastiCache Valkey RBAC user',
      encryptionKey: this.dataKey,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'newapi' }),
        generateStringKey: 'password',
        passwordLength: 48,
        excludeCharacters: URL_UNSAFE_CHARS,
      },
    });

    const cacheUser = new elasticache.CfnUser(this, 'CacheUser', {
      userId: `${cfg.prefix}-app`,
      userName: 'newapi',
      engine: 'valkey',
      // new-api 使用 GET/SET/HASH/Lua 脚本/事务等常规命令；ElastiCache 已禁用 CONFIG 等管理命令
      accessString: 'on ~* +@all',
      authenticationMode: {
        Type: 'password',
        Passwords: [this.cacheSecret.secretValueFromJson('password').unsafeUnwrap()],
      },
    });

    const cacheUserGroup = new elasticache.CfnUserGroup(this, 'CacheUserGroup', {
      userGroupId: `${cfg.prefix}-users`,
      engine: 'valkey',
      userIds: [cacheUser.ref],
    });

    const isolatedSubnetIds = props.vpc.selectSubnets(dataSubnets).subnetIds;
    this.cacheName = `${cfg.prefix}-valkey`;
    const cache = new elasticache.CfnServerlessCache(this, 'Valkey', {
      serverlessCacheName: this.cacheName,
      engine: 'valkey',
      majorEngineVersion: cfg.valkeyMajorVersion,
      description: 'new-api cache / rate limit / session',
      kmsKeyId: this.dataKey.keyId,
      securityGroupIds: [props.cacheSg.securityGroupId],
      subnetIds: isolatedSubnetIds,
      userGroupId: cacheUserGroup.ref,
      snapshotRetentionLimit: 7,
      dailySnapshotTime: '17:00',
      cacheUsageLimits: {
        dataStorage: { maximum: cfg.valkeyMaxDataStorageGb, unit: 'GB' },
        ecpuPerSecond: { maximum: cfg.valkeyMaxEcpuPerSecond },
      },
    });
    // 缓存数据可重建（限流计数 / 渠道缓存），删除栈时随之删除；每日快照保留 7 天
    cache.addResourceDependency(cacheUserGroup);

    this.cacheEndpointAddress = cache.attrEndpointAddress;
    this.cacheEndpointPort = cache.attrEndpointPort;

    // ---------------------------------------------------------------
    // cdk-nag 确认项（附理由）
    // ---------------------------------------------------------------
    acknowledge([this.dbCluster.node.findChild('Secret'), this.cacheSecret, this.sessionSecret, this.cryptoSecret], [
      {
        id: 'AwsSolutions::AwsSolutions-SMG4',
        reason:
          'new-api reads SQL_DSN / REDIS_CONN_STRING / SESSION_SECRET only at start-up, so automatic rotation would break running tasks. ' +
          'Rotate manually in a maintenance window (update the secret, then force a new ECS deployment). CRYPTO_SECRET must never rotate.',
      },
    ]);
    acknowledge(this.dbCluster, [
      {
        id: 'AwsSolutions::AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole]',
        reason: 'RDS Enhanced Monitoring role uses the AWS managed AmazonRDSEnhancedMonitoringRole policy, as recommended by AWS.',
      },
    ]);

  }
}
