#!/usr/bin/env node
import * as cdk from '@aws-cdk/core';
import * as s3 from '@aws-cdk/aws-s3';
import * as cognito from '@aws-cdk/aws-cognito';
import * as iam from '@aws-cdk/aws-iam';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as efs from '@aws-cdk/aws-efs';
import * as ecs from '@aws-cdk/aws-ecs';
import * as elbv2 from '@aws-cdk/aws-elasticloadbalancingv2';
import * as acm from '@aws-cdk/aws-certificatemanager';
import * as lambda from '@aws-cdk/aws-lambda';
import * as events from '@aws-cdk/aws-events';
import * as targets from '@aws-cdk/aws-events-targets';
import * as actions from '@aws-cdk/aws-elasticloadbalancingv2-actions';
import * as route53 from '@aws-cdk/aws-route53';

import { join } from "path";

export enum MlOpsPorts {

  MLFLOW = 5000,

  JUPYTER = 8888,

  TENSORBOARD = 6006,

  DASHBOARD = 8265,

};

export enum MlopsApps {

  MLFLOW = "mlflow",

  JUPYTER = "jupyter",

  TENSORBOARD = "tensorboard",

  DASHBOARD = "dashboard", 

}

export class MLOpsRayStack extends cdk.Stack {

  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // get the input parameters
    const domainName = new cdk.CfnParameter(this, "DomainName", {
      type: "String",
      description: "The base DNS domain name."
    });

    const certificateArn = new cdk.CfnParameter(this, "CertificateArn", {
      type: "String",
      description: "The Amazon Certificate Manager ARN."
    });    

    const zoneId = new cdk.CfnParameter(this, "ZoneId", {
      type: "String",
      description: "The Route53 zone id."
    });   

    // get the default VPC
    const vpc =  new ec2.Vpc(this, 'Vpc');

    // create the source security group for the EFS
    const sourceEfsSecurityGroup = new ec2.SecurityGroup(this, "SourceEfsSecurityGroup", {
      vpc,
    });

    // create the destination security group for the EFS
    const destEfsSecurityGroup = new ec2.SecurityGroup(this, "DestEfsSecurityGroup", {
      vpc,
      allowAllOutbound: false,
    });
    destEfsSecurityGroup.connections.allowFrom(sourceEfsSecurityGroup, ec2.Port.tcp(2049));

    // create the EFS
    const efsFileSystem = new efs.FileSystem(this, "FileSystem", {
      vpc,
      securityGroup: destEfsSecurityGroup,
    });

    // The S3 bucket where model artfifacts are stored
    const s3Bucket = new s3.Bucket(this, 'MLFlowArtifactBucket', {
      versioned: true
    });

    // The Cognito User Pool for authentication
    const userPool = new cognito.UserPool(this, 'myuserpool', {
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
    const userPoolDomain = new cognito.UserPoolDomain(this, 'Domain', {
      userPool,
      cognitoDomain: {
        domainPrefix: 'mlops-devpool',
      },
    }); 

    //  Create the Ray Security Group
    const raySecurityGroup = new ec2.SecurityGroup(this, "RaySecurityGroup", { vpc });
    raySecurityGroup.addIngressRule(raySecurityGroup, ec2.Port.allTraffic(), "Ray security group");
    raySecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), "Allow SSH from anyone");

    // create the User Pool Clients
    const mlflowUserPoolClient = this._createUserPoolClient(MlopsApps.MLFLOW, userPool, domainName.valueAsString);
    const tensorboardUserPoolClient = this._createUserPoolClient(MlopsApps.TENSORBOARD, userPool, domainName.valueAsString);
    const dashboardUserPoolClient = this._createUserPoolClient(MlopsApps.DASHBOARD, userPool, domainName.valueAsString);
    const jupyterUserPoolClient = this._createUserPoolClient(MlopsApps.JUPYTER, userPool, domainName.valueAsString);

    // Create the ALB
    const lb = new elbv2.ApplicationLoadBalancer(this, "ApplicationLoadBalancer", {
        internetFacing: true,
        vpc,
    });
    // allow the ALB to call out to the Cognito service
    lb.connections.allowToAnyIpv4(ec2.Port.tcp(443));
    raySecurityGroup.connections.allowFrom(lb, ec2.Port.tcp(MlOpsPorts.JUPYTER));
    raySecurityGroup.connections.allowFrom(lb, ec2.Port.tcp(MlOpsPorts.MLFLOW));
    raySecurityGroup.connections.allowFrom(lb, ec2.Port.tcp(MlOpsPorts.DASHBOARD));
    raySecurityGroup.connections.allowFrom(lb, ec2.Port.tcp(MlOpsPorts.TENSORBOARD));

    // create a redirect from 80 to 443
    lb.addRedirect();

    // Create the ALB Listeners
    const mlflowTargetGroup = new elbv2.ApplicationTargetGroup(this, "MlflowTargetGroup", {
        port: MlOpsPorts.MLFLOW,
        vpc,
        targetType: elbv2.TargetType.INSTANCE,
        protocol: elbv2.ApplicationProtocol.HTTP,
        healthCheck: {
          healthyThresholdCount: 3,
        },        
    });
    const tensorboardTargetGroup = new elbv2.ApplicationTargetGroup(this, "TensorboardTargetGroup", {
        port: MlOpsPorts.TENSORBOARD,
        vpc,
        targetType: elbv2.TargetType.INSTANCE,
        protocol: elbv2.ApplicationProtocol.HTTP,
        healthCheck: {
          healthyThresholdCount: 3,
        },        
    });
    const dashboardTargetGroup = new elbv2.ApplicationTargetGroup(this, "DashboardTargetGroup", {
        port: MlOpsPorts.DASHBOARD,
        vpc,
        targetType: elbv2.TargetType.INSTANCE,
        protocol: elbv2.ApplicationProtocol.HTTP,
        healthCheck: {
          healthyThresholdCount: 3,
        },        
    });
    const jupyterTargetGroup = new elbv2.ApplicationTargetGroup(this, "JupyterTargetGroup", {
        port: MlOpsPorts.JUPYTER,
        vpc,
        targetType: elbv2.TargetType.INSTANCE,
        protocol: elbv2.ApplicationProtocol.HTTP,
        healthCheck: {
          healthyHttpCodes: "200-302",
          healthyThresholdCount: 3,
        },
    });            

    // Load the Certificate for HTTPS
    const certificate = acm.Certificate.fromCertificateArn(this, 'Certificate', certificateArn.valueAsString);    

    // Create the listeners
    const listener = lb.addListener('Listener', {
        port: 443,
        open: true,
        certificates: [certificate],
        defaultTargetGroups: [dashboardTargetGroup ],
    });

    listener.addAction('MLFlowAction', {
      priority: 30,
      conditions: [
        elbv2.ListenerCondition.hostHeaders([MlopsApps.MLFLOW + '.' + domainName.valueAsString])
      ],
      action: new actions.AuthenticateCognitoAction({
        userPool,
        userPoolClient: mlflowUserPoolClient,
        userPoolDomain,
        next: elbv2.ListenerAction.forward([mlflowTargetGroup]),
      }),
    });

    listener.addAction('TensorboardAction', {
      priority: 40,
      conditions: [
          elbv2.ListenerCondition.hostHeaders([MlopsApps.TENSORBOARD + '.' + domainName.valueAsString])
      ],
      action: new actions.AuthenticateCognitoAction({
        userPool,
        userPoolClient: tensorboardUserPoolClient,
        userPoolDomain,
        next: elbv2.ListenerAction.forward([tensorboardTargetGroup]),
      }),
    });    

    listener.addAction('JupyterAction', {
      priority: 20,
      conditions: [
          elbv2.ListenerCondition.hostHeaders([MlopsApps.JUPYTER + '.' + domainName.valueAsString])
      ],
      action: new actions.AuthenticateCognitoAction({
        userPool,
        userPoolClient: jupyterUserPoolClient,
        userPoolDomain,
        next: elbv2.ListenerAction.forward([jupyterTargetGroup]),
      }),
    });    

    listener.addAction('DashboardAction', {
      priority: 10,
      conditions: [
          elbv2.ListenerCondition.hostHeaders([MlopsApps.DASHBOARD + '.' + domainName.valueAsString])
      ],
      action: new actions.AuthenticateCognitoAction({
        userPool,
        userPoolClient: dashboardUserPoolClient,
        userPoolDomain,
        next: elbv2.ListenerAction.forward([dashboardTargetGroup]),
      }),
    });    

    // Create the Route 53 DNS entries
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'MyZone', {
      zoneName: domainName.valueAsString,
      hostedZoneId: zoneId.valueAsString,
    });

    new route53.CnameRecord(this, "MLflowCnameRecord", {
      zone,
      recordName: MlopsApps.MLFLOW + '.' + domainName.valueAsString,
      domainName: lb.loadBalancerDnsName,
    });

    new route53.CnameRecord(this, "TensorboardCnameRecord", {
      zone,
      recordName: MlopsApps.TENSORBOARD + '.' + domainName.valueAsString,
      domainName: lb.loadBalancerDnsName,
    });

    new route53.CnameRecord(this, "JupyterCnameRecord", {
      zone,
      recordName: MlopsApps.JUPYTER + '.' + domainName.valueAsString,
      domainName: lb.loadBalancerDnsName,
    });

    new route53.CnameRecord(this, "DashboardCnameRecord", {
      zone,
      recordName: MlopsApps.DASHBOARD + '.' + domainName.valueAsString,
      domainName: lb.loadBalancerDnsName,
    });

    // Create the Lambda function to register the instance
    const fn = new lambda.Function(this, 'MyLambda', {
        code: lambda.Code.fromAsset(join(__dirname, "..", 'lambda', 'ec2-event-processor')),
        handler: 'handler.lambda_handler',
        runtime: lambda.Runtime.PYTHON_3_7,
        environment: {
            MLFLOW_TARGET_GROUP_ARN: mlflowTargetGroup.targetGroupArn,
            TENSORBOARD_TARGET_GROUP_ARN: tensorboardTargetGroup.targetGroupArn,
            RAY_DASHBOARD_TARGET_GROUP_ARN: dashboardTargetGroup.targetGroupArn,
            JUPYTER_TARGET_GROUP_ARN: jupyterTargetGroup.targetGroupArn,
        }
    });

    // Add statements to Lambda function role
    fn.role?.addToPrincipalPolicy(new iam.PolicyStatement({
        resources: ['*'],
        actions: ['ec2:DescribeInstances']
    }));
    fn.role?.addToPrincipalPolicy(new iam.PolicyStatement({
        resources: [ mlflowTargetGroup.targetGroupArn, tensorboardTargetGroup.targetGroupArn, dashboardTargetGroup.targetGroupArn, jupyterTargetGroup.targetGroupArn ],
        actions: [ 'elasticloadbalancing:DeregisterTargets', 'elasticloadbalancing:RegisterTargets' ]
      }
    ));

    const rule = new events.Rule(this, 'rule', {
        eventPattern: {
            source: ["aws.ec2"],
            detailType: ["EC2 Instance State-change Notification"],
        },
    });
      
    rule.addTarget(new targets.LambdaFunction(fn, {
        maxEventAge: cdk.Duration.hours(2), // Optional: set the maxEventAge retry policy
        retryAttempts: 2, // Optional: set the max number of retry attempts
    }));      
    
    new cdk.CfnOutput(this, "S3Bucket", {
      value: s3Bucket.bucketName,
    });

    new cdk.CfnOutput(this, "AlbDnsName", {
      value: lb.loadBalancerDnsName,
    });

    new cdk.CfnOutput(this, "EfsFileSystem", {
      value: efsFileSystem.fileSystemId,
    });

  }

  private _createUserPoolClient(name: string, userPool: cognito.UserPool, baseDomain: string) {

    // Create Cognito User Pool clients for each endpoint
    return new cognito.UserPoolClient(this, name + 'UserPoolClient', {
      userPool,
      userPoolClientName: name + "UserPoolClient",
      authFlows: {
        userPassword: true
      },
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
        },
        scopes: [ cognito.OAuthScope.EMAIL, cognito.OAuthScope.OPENID, cognito.OAuthScope.PROFILE, cognito.OAuthScope.COGNITO_ADMIN ],
        callbackUrls: [ 'https://' + name + "." + baseDomain + '/oauth2/idpresponse' ]
      },
      supportedIdentityProviders: [ cognito.UserPoolClientIdentityProvider.COGNITO ],
      refreshTokenValidity: cdk.Duration.days(1),
      generateSecret: true,
    });
  }

}
