import * as cdk from '@aws-cdk/core';
import * as s3 from '@aws-cdk/aws-s3';
import * as cognito from '@aws-cdk/aws-cognito';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as efs from '@aws-cdk/aws-efs';
import * as ecs from '@aws-cdk/aws-ecs';
import * as servicediscovery from '@aws-cdk/aws-servicediscovery';

export interface MlflowFargateBaseStackProps extends cdk.StackProps {

  readonly domainName: string;    

}


export class MlflowFargateBaseStack extends cdk.Stack {

  public readonly vpc: ec2.IVpc;

  public readonly cluster: ecs.ICluster;

  public readonly s3Bucket: s3.IBucket;

  public readonly efsFileSystem: efs.IFileSystem;

  public readonly sourceEfsSecurityGroup: ec2.ISecurityGroup;

  public readonly userPool: cognito.IUserPool;

  public readonly userPoolDomain: cognito.IUserPoolDomain;

  constructor(scope: cdk.Construct, id: string, props: MlflowFargateBaseStackProps) {
    super(scope, id, props);

    // get the default VPC
    this.vpc =  new ec2.Vpc(this, 'Vpc');

    // The ECS cluster
    const ecsCluster = new ecs.Cluster(this, 'Cluster', {
      vpc: this.vpc,
    });
    ecsCluster.addDefaultCloudMapNamespace({ name: "internal." + props.domainName, vpc: this.vpc });
    this.cluster = ecsCluster;

    // create the source security group for the EFS
    this.sourceEfsSecurityGroup = new ec2.SecurityGroup(this, "SourceEfsSecurityGroup", {
      vpc: this.vpc,
    });

    // create the destination security group for the EFS
    const destEfsSecurityGroup = new ec2.SecurityGroup(this, "DestEfsSecurityGroup", {
      vpc: this.vpc,
      allowAllOutbound: false,
    });
    destEfsSecurityGroup.connections.allowFrom(this.sourceEfsSecurityGroup, ec2.Port.tcp(2049));

    // create the EFS
    this.efsFileSystem = new efs.FileSystem(this, "FileSystem", {
      vpc: this.vpc,
      securityGroup: destEfsSecurityGroup,
    });

    // The S3 bucket where model artfifacts are stored
    this.s3Bucket = new s3.Bucket(this, 'MLFlowArtifactBucket', {
      versioned: true
    });

    // The Cognito User Pool for authentication
    this.userPool = new cognito.UserPool(this, 'myuserpool', {
      passwordPolicy: {
        minLength: 16,
        requireLowercase: false,
        requireUppercase: false,
        requireDigits: false,
        requireSymbols: false,
        tempPasswordValidity: cdk.Duration.days(3),
      },
      selfSignUpEnabled: false,
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,     
      signInAliases: { email: true },
      autoVerify: { email: true },
    });

    // The Cognito user pool domain
    this.userPoolDomain = new cognito.UserPoolDomain(this, 'Domain', {
      userPool: this.userPool,
      cognitoDomain: {
        domainPrefix: 'mlops-devpool',
      },
    }); 

    // Create a CFN output for the Cognito User Pool
    new cdk.CfnOutput(this, 'CognitoUserPoolArnOutput', {
      value: this.userPool.userPoolArn,
      exportName: "CognitoUserPoolArn",
    });     
    
    // Create a CFN output for the Cognito User Pool
    new cdk.CfnOutput(this, 'CognitoUserPoolIdOutput', {
      value: this.userPool.userPoolId,
      exportName: "CognitoUserPoolId",
    });        

    // Create a CFN output for the Cognito User Pool
    new cdk.CfnOutput(this, 'CognitoUserPoolDomainName', {
      value: this.userPoolDomain.domainName,
      exportName: "CognitoUserPoolDomainName",
    });       
  }
}
