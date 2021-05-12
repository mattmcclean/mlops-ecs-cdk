import * as cdk from '@aws-cdk/core';
import * as s3 from '@aws-cdk/aws-s3';
import * as cognito from '@aws-cdk/aws-cognito';
import * as elbv2 from '@aws-cdk/aws-elasticloadbalancingv2';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as acm from '@aws-cdk/aws-certificatemanager';
import * as ecs from '@aws-cdk/aws-ecs';
import * as ecs_patterns from '@aws-cdk/aws-ecs-patterns';
import * as efs from '@aws-cdk/aws-efs';
import * as route53 from '@aws-cdk/aws-route53';

import { DockerImageAsset } from "@aws-cdk/aws-ecr-assets";
import { join } from "path";

export interface MLOpsEcsMlflowStackProps extends cdk.StackProps {
  
  s3Bucket: s3.IBucket;

  vpc: ec2.IVpc;

  cluster: ecs.ICluster;

  efsFileSystem: efs.IFileSystem;

  efsSecurityGroup: ec2.ISecurityGroup;

  serviceName: string;

  baseDomainName: string;

  certificateArn: string;

  hostedZoneId: string;
}

export class MLOpsEcsMlflowStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props: MLOpsEcsMlflowStackProps) {
    super(scope, id, props);

    // The Docker Image  
    const image = new DockerImageAsset(this, "MlflowImage", {
      directory: join(__dirname, "..", "docker"),
    });

    // Load the Certificate for HTTPS
    const certificate = acm.Certificate.fromCertificateArn(this, 'Certificate', props.certificateArn);    

    // get the domain name combining the base name and the service name
    const dnsName = props.serviceName + "." + props.baseDomainName;

    // Load the Route 53 hosted zone
    const domainZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      zoneName: dnsName,
      hostedZoneId: props.hostedZoneId,
    });

    // Create the Fargate Task Definition
    const taskDefinition = new ecs.FargateTaskDefinition(this, "TaskDef", {
      memoryLimitMiB: 1024,
      cpu: 512,      
      volumes: [
        {
          name: "efs-vol",
          efsVolumeConfiguration: {
            fileSystemId: props.efsFileSystem.fileSystemId,
          }
        }
      ],
    });
    
    // the directories mounted and on the drive
    const mountDir = "/mnt/efs"
    const backendDir = mountDir + "/mlflow/mlruns/";

    // Create the Container for the Fargate Task Definition
    const container = taskDefinition.addContainer("MlflowContainer", {
      image: ecs.ContainerImage.fromDockerImageAsset(image),
      containerName: "mlflow",
      command: [ "--backend-store-uri", "file://" + backendDir, "--default-artifact-root", 
                    "s3://" + props.s3Bucket.bucketName + "/mlflow/model-artifacts/" ],
      portMappings: [
        {
          containerPort: 80,
          hostPort: 80,
        }
      ],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'MlflowServer' })
    });

    // Create the EFS mount points
    container.addMountPoints({
      sourceVolume: "efs-vol",
      containerPath: mountDir,
      readOnly: false,
    });

    // get the EFS security group
    const efsSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(this, "EfsSecurityGroup", props.efsSecurityGroup.securityGroupId);

    // The load balanced service    
    const fargateService = new ecs_patterns.ApplicationLoadBalancedFargateService(this, 'FargateAlbService', {
      cluster: props.cluster,
      desiredCount: 1,
      publicLoadBalancer: true,
      certificate,
      domainName: dnsName,
      domainZone,
      redirectHTTP: true,      
      taskDefinition,
      securityGroups: [efsSecurityGroup ],
      serviceName: props.serviceName,
      cloudMapOptions: { name: props.serviceName }
    }); 

    // Let the service have access to the S3 bucket
    props.s3Bucket.grantReadWrite(taskDefinition.taskRole);

    // get the User Pool id from exported value
    const userPool = cognito.UserPool.fromUserPoolId(this, "UserPool", cdk.Fn.importValue("CognitoUserPoolId"));

    // the Cognito user pool client
    const userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
      userPool,
      userPoolClientName: "AlbAuthentication",
      authFlows: {
        userPassword: true
      },
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
        },
        scopes: [ cognito.OAuthScope.EMAIL, cognito.OAuthScope.OPENID, cognito.OAuthScope.PROFILE, cognito.OAuthScope.COGNITO_ADMIN ],
        callbackUrls: [ 'https://' + dnsName + '/oauth2/idpresponse' ]
      },
      supportedIdentityProviders: [ cognito.UserPoolClientIdentityProvider.COGNITO ],
      refreshTokenValidity: cdk.Duration.days(30),
      generateSecret: true,
    });

    // Allow ALB to talk to any service running HTTPS (for Cognito)
    fargateService.loadBalancer.connections.allowToAnyIpv4(ec2.Port.tcp(443));

    // Get the AWS CloudFormation resource
    const cfnListener = fargateService.listener.node.defaultChild as elbv2.CfnListener;
    cfnListener.addPropertyOverride("DefaultActions.0.Order", "2");
    cfnListener.addPropertyOverride("DefaultActions.1.Type", "authenticate-cognito");
    cfnListener.addPropertyOverride("DefaultActions.1.AuthenticateCognitoConfig.OnUnauthenticatedRequest", "authenticate");
    cfnListener.addPropertyOverride("DefaultActions.1.AuthenticateCognitoConfig.Scope", "openid");
    cfnListener.addPropertyOverride("DefaultActions.1.AuthenticateCognitoConfig.UserPoolArn", cdk.Fn.importValue("CognitoUserPoolArn"));
    cfnListener.addPropertyOverride("DefaultActions.1.AuthenticateCognitoConfig.UserPoolClientId", userPoolClient.userPoolClientId);
    cfnListener.addPropertyOverride("DefaultActions.1.AuthenticateCognitoConfig.UserPoolDomain", cdk.Fn.importValue("CognitoUserPoolDomainName"));
    cfnListener.addPropertyOverride("DefaultActions.1.Order", "1");

    // create an CFN output
    new cdk.CfnOutput(this, 'Endpoint', {
      value: 'https://' + dnsName + '/',
    });
  }
}