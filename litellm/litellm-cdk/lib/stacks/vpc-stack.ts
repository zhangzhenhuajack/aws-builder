import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { VpcStackProps } from '../interfaces/stack-props';

export class VpcStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly publicSubnets: ec2.ISubnet[];
  public readonly privateSubnets: ec2.ISubnet[];
  public readonly bedrockEndpointSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: VpcStackProps) {
    super(scope, id, props);

    const { config } = props;

    // Create VPC with 2 AZs, public/private subnets, and 2 NAT Gateways
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(config.vpcCidr),
      maxAzs: 2,
      natGateways: 2,
      enableDnsSupport: true,
      enableDnsHostnames: true,
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
          mapPublicIpOnLaunch: true,
        },
        {
          name: 'private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    // Export subnet references
    this.publicSubnets = this.vpc.publicSubnets;
    this.privateSubnets = this.vpc.privateSubnets;

    // Tag VPC with environment name
    cdk.Tags.of(this.vpc).add('Name', `${config.environmentName}-vpc`);

    // Bedrock Endpoint Security Group - allows HTTPS (443) from VPC CIDR only
    this.bedrockEndpointSecurityGroup = new ec2.SecurityGroup(this, 'BedrockEndpointSecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for Bedrock VPC Endpoint',
      allowAllOutbound: true,
    });

    this.bedrockEndpointSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(config.vpcCidr),
      ec2.Port.tcp(443),
      'Allow HTTPS from within VPC',
    );

    cdk.Tags.of(this.bedrockEndpointSecurityGroup).add('Name', `${config.environmentName}-bedrock-vpce-sg`);

    // Bedrock Runtime Interface VPC Endpoint (PrivateLink)
    new ec2.InterfaceVpcEndpoint(this, 'BedrockRuntimeEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME,
      privateDnsEnabled: true,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [this.bedrockEndpointSecurityGroup],
    });

    // Bedrock Interface VPC Endpoint (PrivateLink)
    new ec2.InterfaceVpcEndpoint(this, 'BedrockEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.BEDROCK,
      privateDnsEnabled: true,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [this.bedrockEndpointSecurityGroup],
    });

    // S3 Gateway VPC Endpoint - associated with private route tables
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
    });
  }
}
