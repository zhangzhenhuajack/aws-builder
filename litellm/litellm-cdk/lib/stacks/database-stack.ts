import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import { DatabaseStackProps } from '../interfaces/stack-props';

export class DatabaseStack extends cdk.Stack {
  public readonly auroraCluster: rds.DatabaseCluster;
  public readonly auroraSecret: secretsmanager.ISecret;
  public readonly auroraSecurityGroup: ec2.SecurityGroup;
  public readonly redisEndpoint: string;
  public readonly redisPort: string;
  public readonly redisSecurityGroup: ec2.SecurityGroup;
  public readonly dynamoTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id, props);

    const { config } = props;

    // ============================================================
    // Aurora PostgreSQL Serverless v2
    // ============================================================

    // Create Aurora master password Secret in Secrets Manager
    const auroraSecret = new secretsmanager.Secret(this, 'AuroraSecret', {
      secretName: `${config.environmentName}/aurora/master-password`,
      description: `Master credentials for ${config.environmentName} Aurora PostgreSQL cluster`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'litellm_admin' }),
        generateStringKey: 'password',
        passwordLength: 32,
        excludeCharacters: '"@/\\',
      },
    });

    cdk.Tags.of(auroraSecret).add('Name', `${config.environmentName}-aurora-secret`);
    cdk.Tags.of(auroraSecret).add('Environment', config.environmentName);

    // Aurora Security Group
    this.auroraSecurityGroup = new ec2.SecurityGroup(this, 'AuroraSecurityGroup', {
      vpc: props.vpc,
      description: 'Security group for Aurora PostgreSQL Serverless v2',
      allowAllOutbound: true,
    });

    this.auroraSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(config.vpcCidr),
      ec2.Port.tcp(5432),
      'Allow PostgreSQL access from within VPC',
    );

    cdk.Tags.of(this.auroraSecurityGroup).add('Name', `${config.environmentName}-aurora-sg`);

    // Aurora PostgreSQL Serverless v2 Cluster
    this.auroraCluster = new rds.DatabaseCluster(this, 'AuroraCluster', {
      clusterIdentifier: `${config.environmentName}-aurora-cluster`,
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_6,
      }),
      credentials: rds.Credentials.fromSecret(auroraSecret),
      defaultDatabaseName: 'litellm',
      vpc: props.vpc,
      vpcSubnets: {
        subnets: props.privateSubnets,
      },
      securityGroups: [this.auroraSecurityGroup],
      serverlessV2MinCapacity: config.auroraMinAcu,
      serverlessV2MaxCapacity: config.auroraMaxAcu,
      writer: rds.ClusterInstance.serverlessV2('writer', {
        publiclyAccessible: false,
      }),
      readers: [
        rds.ClusterInstance.serverlessV2('reader1', {
          publiclyAccessible: false,
        }),
        rds.ClusterInstance.serverlessV2('reader2', {
          publiclyAccessible: false,
        }),
      ],
      storageEncrypted: true,
      deletionProtection: true,
      backup: {
        retention: cdk.Duration.days(7),
      },
      enableDataApi: true,
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
    });

    cdk.Tags.of(this.auroraCluster).add('Name', `${config.environmentName}-aurora-cluster`);
    cdk.Tags.of(this.auroraCluster).add('Environment', config.environmentName);

    // Attach secret to cluster for rotation support
    this.auroraSecret = this.auroraCluster.secret!;

    // ============================================================
    // ElastiCache Redis Serverless
    // ============================================================

    // Redis Security Group
    this.redisSecurityGroup = new ec2.SecurityGroup(this, 'RedisSecurityGroup', {
      vpc: props.vpc,
      description: 'Security group for ElastiCache Redis Serverless',
      allowAllOutbound: true,
    });

    this.redisSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(config.vpcCidr),
      ec2.Port.tcp(6379),
      'Allow Redis access from within VPC',
    );

    this.redisSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(config.vpcCidr),
      ec2.Port.tcp(6380),
      'Allow Redis TLS access from within VPC',
    );

    cdk.Tags.of(this.redisSecurityGroup).add('Name', `${config.environmentName}-redis-sg`);

    // Redis Subnet Group
    const redisSubnetGroup = new elasticache.CfnSubnetGroup(this, 'RedisSubnetGroup', {
      cacheSubnetGroupName: `${config.environmentName}-redis-subnet-group`,
      description: 'Subnet group for Redis Serverless in private subnets',
      subnetIds: props.privateSubnets.map(s => s.subnetId),
    });

    // Redis Serverless Cache
    const redisServerless = new elasticache.CfnServerlessCache(this, 'RedisServerless', {
      serverlessCacheName: `${config.environmentName}-redis`,
      engine: 'redis',
      majorEngineVersion: '7',
      securityGroupIds: [this.redisSecurityGroup.securityGroupId],
      subnetIds: props.privateSubnets.map(s => s.subnetId),
      cacheUsageLimits: {
        dataStorage: {
          maximum: config.redisMaxMemory,
          unit: 'GB',
        },
        ecpuPerSecond: {
          maximum: config.redisMaxEcpu,
        },
      },
    });

    redisServerless.addDependency(redisSubnetGroup);

    cdk.Tags.of(redisServerless).add('Name', `${config.environmentName}-redis`);
    cdk.Tags.of(redisServerless).add('Environment', config.environmentName);

    // Get Redis endpoint via L1 attributes
    this.redisEndpoint = redisServerless.attrEndpointAddress;
    this.redisPort = redisServerless.attrEndpointPort;

    // ============================================================
    // DynamoDB Table
    // ============================================================

    this.dynamoTable = new dynamodb.Table(this, 'DynamoDBTable', {
      tableName: `${config.environmentName}-litellm-sessions`,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: {
        name: 'pk',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'sk',
        type: dynamodb.AttributeType.STRING,
      },
      timeToLiveAttribute: 'ttl',
      pointInTimeRecovery: true,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Add GSI
    this.dynamoTable.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: {
        name: 'gsi1pk',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'gsi1sk',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    cdk.Tags.of(this.dynamoTable).add('Name', `${config.environmentName}-litellm-sessions`);
    cdk.Tags.of(this.dynamoTable).add('Environment', config.environmentName);
  }
}
