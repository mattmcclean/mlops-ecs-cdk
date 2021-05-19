#!/usr/bin/env node
import * as cdk from '@aws-cdk/core';
import * as s3 from '@aws-cdk/aws-s3';
import * as cognito from '@aws-cdk/aws-cognito';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as efs from '@aws-cdk/aws-efs';
import * as iam from '@aws-cdk/aws-iam';

export class MLOpsBaseStack extends cdk.Stack {

  public vpc: ec2.IVpc;

  public s3Bucket: s3.IBucket;

  public efsFileSystem: efs.IFileSystem;

  public userPool: cognito.IUserPool;

  public userPoolDomain: cognito.IUserPoolDomain;

  public sourceEfsSecurityGroup: ec2.ISecurityGroup;

  public raySecurityGroup: ec2.ISecurityGroup;

  public albSecurityGroup: ec2.ISecurityGroup;

  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // get the default VPC
    this.vpc =  new ec2.Vpc(this, 'Vpc');

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

    //  Create the Ray Security Group
    this.raySecurityGroup = new ec2.SecurityGroup(this, "RaySecurityGroup", { vpc: this.vpc });
    this.raySecurityGroup.addIngressRule(this.raySecurityGroup, ec2.Port.allTraffic(), "Ray security group");
    this.raySecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), "Allow SSH from anyone");
    
    //  Create the Ray Security Group
    this.albSecurityGroup = new ec2.SecurityGroup(this, "AlbSecurityGroup", { vpc: this.vpc, allowAllOutbound: false });
    this.albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "Allow HTTP from anyone");
    this.albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "Allow HTTPS from anyone");
    this.albSecurityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "Allow HTTP to anyone");

    // Setup the ports to the various applications
    this.albSecurityGroup.addEgressRule(this.raySecurityGroup, ec2.Port.tcp(5000), "Allow traffic to mlflow service");
    this.raySecurityGroup.addIngressRule(this.albSecurityGroup, ec2.Port.tcp(5000), "Allow traffic to mlflow service");
    this.albSecurityGroup.addEgressRule(this.raySecurityGroup, ec2.Port.tcp(8888), "Allow traffic to jupyter service");
    this.raySecurityGroup.addIngressRule(this.albSecurityGroup, ec2.Port.tcp(8888), "Allow traffic to jupyter service");
    this.albSecurityGroup.addEgressRule(this.raySecurityGroup, ec2.Port.tcp(6006), "Allow traffic to tensorboard service");
    this.raySecurityGroup.addIngressRule(this.albSecurityGroup, ec2.Port.tcp(6006), "Allow traffic to tensorboard service");
    this.albSecurityGroup.addEgressRule(this.raySecurityGroup, ec2.Port.tcp(8265), "Allow traffic to ray dashboard service");
    this.raySecurityGroup.addIngressRule(this.albSecurityGroup, ec2.Port.tcp(8265), "Allow traffic to ray dashboard service");        
    this.albSecurityGroup.addEgressRule(this.raySecurityGroup, ec2.Port.tcp(9090), "Allow traffic to prometheus service");
    this.raySecurityGroup.addIngressRule(this.albSecurityGroup, ec2.Port.tcp(9090), "Allow traffic to prometheus service");   

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
    this.userPoolDomain = new cognito.UserPoolDomain(this, 'UserPoolDomain', {
      userPool: this.userPool,
      cognitoDomain: {
        domainPrefix: 'mlops-devpool',
      },
    });

    // Create the Launch Templates
    const setupCommands = ec2.UserData.forLinux();
    setupCommands.addCommands('echo "' + this.efsFileSystem.fileSystemId  + '.efs.'+ cdk.Stack.of(this).region + '.amazonaws.com:/ /mnt/efs nfs4 nfsvers=4.1,rsize=1048576,wsize=1048576,hard,timeo=600,retrans=2 0 0" >> /etc/fstab');

    const headNodeLaunchTemplate = new ec2.LaunchTemplate(this, "HeadNodeLaunchTemplate", {
      userData: setupCommands,
      blockDevices: [
        {
          deviceName: '/dev/sda1',
          volume: ec2.BlockDeviceVolume.ebs(200),
        },     
      ]
    });

    const workerNodeLaunchTemplate = new ec2.LaunchTemplate(this, "WorkerNodeLaunchTemplate", {
      role: iam.Role.fromRoleArn(this, "WorkerNodeRole", `arn:aws:iam::${cdk.Stack.of(this).account}:role/ray-worker-v1`),
      spotOptions: {
        requestType: ec2.SpotRequestType.ONE_TIME,
      },
      blockDevices: [
        {
          deviceName: '/dev/sda1',
          volume: ec2.BlockDeviceVolume.ebs(150),
        },     
      ],
    });

    // Define the CFN outputs    
    new cdk.CfnOutput(this, "CognitoUserPoolIdOutput", {
      value: this.userPool.userPoolId,
      exportName: "MLOpsCognitoUserPoolId"
    });
  
    new cdk.CfnOutput(this, "CognitoUserPoolDomainOutput", {
      value: this.userPoolDomain.domainName,
      exportName: "MLOpsCognitoUserPoolDomain",
    });    

    new cdk.CfnOutput(this, "S3BucketOutput", {
      value: this.s3Bucket.bucketName,
    });
  
    new cdk.CfnOutput(this, "EfsFileSystemOutput", {
      value: this.efsFileSystem.fileSystemId,
    });   
    
    new cdk.CfnOutput(this, "SrcEfsSecurityGroupOutput", {
      value: this.sourceEfsSecurityGroup.securityGroupId,
    });    

    new cdk.CfnOutput(this, "RaySecurityGroupOutput", {
      value: this.raySecurityGroup.securityGroupId,
    });       

    let headNodeLaunchTemplateOutput;
    if (headNodeLaunchTemplate.launchTemplateId) {
      headNodeLaunchTemplateOutput = `LaunchTemplateId=${headNodeLaunchTemplate.launchTemplateId}`
    } else {
      headNodeLaunchTemplateOutput = `LaunchTemplateName=${headNodeLaunchTemplate.launchTemplateName}`
    }
    headNodeLaunchTemplateOutput=`${headNodeLaunchTemplateOutput},Version=${headNodeLaunchTemplate.latestVersionNumber}`

    new cdk.CfnOutput(this, "RayHeadNodeLaunchTemplateOutput", {
      value: headNodeLaunchTemplateOutput,
    });  

    let workerNodeLaunchTemplateOutput;
    if (workerNodeLaunchTemplate.launchTemplateId) {
      workerNodeLaunchTemplateOutput = `LaunchTemplateId=${workerNodeLaunchTemplate.launchTemplateId}`
    } else {
      workerNodeLaunchTemplateOutput = `LaunchTemplateName=${workerNodeLaunchTemplate.launchTemplateName}`
    }
    workerNodeLaunchTemplateOutput=`${workerNodeLaunchTemplateOutput},Version=${workerNodeLaunchTemplate.latestVersionNumber}`

    new cdk.CfnOutput(this, "RayWorkerNodeLaunchTemplateOutput", {
      value: workerNodeLaunchTemplateOutput,
    });      

  }
}
