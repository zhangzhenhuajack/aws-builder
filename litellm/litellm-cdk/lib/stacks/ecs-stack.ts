import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { EcsStackProps } from '../interfaces/stack-props';

export class EcsStack extends cdk.Stack {
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly albSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: EcsStackProps) {
    super(scope, id, props);

    const { config } = props;

    // ============================================================
    // 7.1 IAM Roles and Secrets
    // ============================================================

    // LiteLLM Master Key Secret
    const masterKeySecret = new secretsmanager.Secret(this, 'MasterKeySecret', {
      secretName: `${config.environmentName}/litellm/master-key`,
      description: 'LiteLLM Master Key for admin access',
      generateSecretString: {
        secretStringTemplate: '{}',
        generateStringKey: 'LITELLM_MASTER_KEY',
        passwordLength: 40,
        excludeCharacters: '"@/\\',
        includeSpace: false,
      },
    });

    cdk.Tags.of(masterKeySecret).add('Name', `${config.environmentName}-master-key`);
    cdk.Tags.of(masterKeySecret).add('Environment', config.environmentName);

    // Task Execution Role
    const taskExecutionRole = new iam.Role(this, 'TaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    // Grant read access to secrets for task execution role
    masterKeySecret.grantRead(taskExecutionRole);
    props.auroraSecret.grantRead(taskExecutionRole);

    // Task Role
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        props.bedrockPolicy,
      ],
    });

    // S3 Access Policy
    taskRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject'],
      resources: [`${props.bucket.bucketArn}/config/*`],
    }));

    taskRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:PutObject', 's3:GetObject'],
      resources: [`${props.bucket.bucketArn}/litellm-logs/*`],
    }));

    taskRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:ListBucket'],
      resources: [props.bucket.bucketArn],
    }));

    // DynamoDB Access Policy
    taskRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'dynamodb:PutItem',
        'dynamodb:GetItem',
        'dynamodb:UpdateItem',
        'dynamodb:DeleteItem',
        'dynamodb:Query',
        'dynamodb:Scan',
      ],
      resources: [
        props.dynamoTable.tableArn,
        `${props.dynamoTable.tableArn}/index/*`,
      ],
    }));

    // ElastiCache Access Policy
    taskRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'elasticache:Connect',
        'elasticache:DescribeServerlessCaches',
      ],
      resources: ['*'],
    }));

    // ============================================================
    // 7.2 ECS Cluster and Task Definition
    // ============================================================

    // ECS Cluster with Container Insights
    const cluster = new ecs.Cluster(this, 'ECSCluster', {
      clusterName: `${config.environmentName}-ecs-cluster`,
      vpc: props.vpc,
      containerInsights: true,
    });

    cdk.Tags.of(cluster).add('Name', `${config.environmentName}-ecs-cluster`);
    cdk.Tags.of(cluster).add('Environment', config.environmentName);

    // CloudWatch Log Group
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/ecs/${config.environmentName}/litellm`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Fargate Task Definition
    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      family: `${config.environmentName}-litellm`,
      cpu: config.taskCpu,
      memoryLimitMiB: config.taskMemory,
      executionRole: taskExecutionRole,
      taskRole: taskRole,
    });

    // Shared volume
    taskDef.addVolume({ name: 'config-volume' });

    // Init container: download config from S3
    const initContainer = taskDef.addContainer('config-init', {
      image: ecs.ContainerImage.fromRegistry('amazon/aws-cli:latest'),
      essential: false,
      command: [
        's3',
        'cp',
        `s3://${props.bucket.bucketName}/config/litellm_config.yaml`,
        '/config/litellm_config.yaml',
      ],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'config-init',
        logGroup,
      }),
    });

    initContainer.addMountPoints({
      sourceVolume: 'config-volume',
      containerPath: '/config',
      readOnly: false,
    });

    // Main container: LiteLLM
    const auroraEndpoint = props.auroraCluster.clusterEndpoint.hostname;
    const databaseUrlCommand = `export DATABASE_URL=$(python3 -c 'import urllib.parse,os;u=urllib.parse.quote(os.environ["DB_USERNAME"],safe="");p=urllib.parse.quote(os.environ["DB_PASSWORD"],safe="");print(f"postgresql://{u}:{p}@${auroraEndpoint}:5432/litellm")') && exec litellm --config /config/litellm_config.yaml`;

    const mainContainer = taskDef.addContainer('litellm', {
      image: ecs.ContainerImage.fromRegistry(config.litellmImage),
      essential: true,
      portMappings: [{ containerPort: 4000, protocol: ecs.Protocol.TCP }],
      entryPoint: ['/bin/sh', '-c'],
      command: [databaseUrlCommand],
      environment: {
        REDIS_HOST: props.redisEndpoint,
        REDIS_PORT: props.redisPort,
        S3_BUCKET_NAME: props.bucket.bucketName,
        AWS_DEFAULT_REGION: cdk.Aws.REGION,
      },
      secrets: {
        LITELLM_MASTER_KEY: ecs.Secret.fromSecretsManager(masterKeySecret, 'LITELLM_MASTER_KEY'),
        DB_USERNAME: ecs.Secret.fromSecretsManager(props.auroraSecret, 'username'),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(props.auroraSecret, 'password'),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'litellm',
        logGroup,
      }),
      healthCheck: {
        command: [
          'CMD-SHELL',
          'python3 -c \'import urllib.request; urllib.request.urlopen("http://localhost:4000/health/liveliness")\' || exit 1',
        ],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        retries: 5,
        startPeriod: cdk.Duration.seconds(120),
      },
    });

    mainContainer.addContainerDependencies({
      container: initContainer,
      condition: ecs.ContainerDependencyCondition.SUCCESS,
    });

    mainContainer.addMountPoints({
      sourceVolume: 'config-volume',
      containerPath: '/config',
      readOnly: true,
    });

    // ============================================================
    // 7.3 ALB and ECS Service
    // ============================================================

    // ALB Security Group
    this.albSecurityGroup = new ec2.SecurityGroup(this, 'ALBSecurityGroup', {
      vpc: props.vpc,
      description: 'Security group for internal ALB (CloudFront VPC origin)',
      allowAllOutbound: true,
    });

    this.albSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(config.vpcCidr),
      ec2.Port.tcp(80),
      'Allow HTTP from within VPC',
    );

    cdk.Tags.of(this.albSecurityGroup).add('Name', `${config.environmentName}-alb-sg`);

    // ECS Security Group
    const ecsSecurityGroup = new ec2.SecurityGroup(this, 'ECSSecurityGroup', {
      vpc: props.vpc,
      description: 'Security group for ECS tasks',
      allowAllOutbound: true,
    });

    ecsSecurityGroup.addIngressRule(
      this.albSecurityGroup,
      ec2.Port.tcp(4000),
      'Allow traffic from ALB only',
    );

    cdk.Tags.of(ecsSecurityGroup).add('Name', `${config.environmentName}-ecs-sg`);

    // Internal Application Load Balancer
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'ALB', {
      loadBalancerName: `${config.environmentName}-int-alb`,
      vpc: props.vpc,
      vpcSubnets: { subnets: props.privateSubnets },
      internetFacing: false,
      securityGroup: this.albSecurityGroup,
      idleTimeout: cdk.Duration.seconds(120),
      dropInvalidHeaderFields: true,
    });

    cdk.Tags.of(this.alb).add('Name', `${config.environmentName}-int-alb`);

    // Target Group
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'ALBTargetGroup', {
      targetGroupName: `${config.environmentName}-ecs-tg`,
      port: 4000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      vpc: props.vpc,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/health/liveliness',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 5,
      },
      deregistrationDelay: cdk.Duration.seconds(60),
    });

    // HTTP Listener
    this.alb.addListener('HTTPListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultTargetGroups: [targetGroup],
    });

    // ECS Fargate Service
    const service = new ecs.FargateService(this, 'ECSService', {
      serviceName: `${config.environmentName}-litellm-service`,
      cluster,
      taskDefinition: taskDef,
      desiredCount: config.desiredCount,
      vpcSubnets: { subnets: props.privateSubnets },
      securityGroups: [ecsSecurityGroup],
      assignPublicIp: false,
      circuitBreaker: { rollback: true },
      healthCheckGracePeriod: cdk.Duration.seconds(300),
      enableExecuteCommand: true,
    });

    service.attachToApplicationTargetGroup(targetGroup);

    cdk.Tags.of(service).add('Name', `${config.environmentName}-litellm-service`);

    // ============================================================
    // 7.4 Auto Scaling
    // ============================================================

    const scaling = service.autoScaleTaskCount({
      minCapacity: config.desiredCount,
      maxCapacity: 10,
    });

    // CPU target tracking
    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 70,
      scaleInCooldown: cdk.Duration.seconds(300),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });

    // Memory target tracking
    scaling.scaleOnMemoryUtilization('MemoryScaling', {
      targetUtilizationPercent: 80,
      scaleInCooldown: cdk.Duration.seconds(300),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });
  }
}
