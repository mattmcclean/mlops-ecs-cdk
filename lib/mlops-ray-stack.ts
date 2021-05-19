#!/usr/bin/env node
import * as cdk from '@aws-cdk/core';
import * as cognito from '@aws-cdk/aws-cognito';
import * as iam from '@aws-cdk/aws-iam';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as elbv2 from '@aws-cdk/aws-elasticloadbalancingv2';
import * as acm from '@aws-cdk/aws-certificatemanager';
import * as lambda from '@aws-cdk/aws-lambda';
import * as events from '@aws-cdk/aws-events';
import * as targets from '@aws-cdk/aws-events-targets';
import * as actions from '@aws-cdk/aws-elasticloadbalancingv2-actions';
import * as route53 from '@aws-cdk/aws-route53';
import * as ssm from '@aws-cdk/aws-ssm';

var path = require('path');

export interface MLOpsRayStackProps extends cdk.StackProps {

  vpc: ec2.IVpc;

  raySecurityGroup: ec2.ISecurityGroup;

  albSecurityGroup: ec2.ISecurityGroup;

}

export class MLOpsRayStack extends cdk.Stack {

  private lb: elbv2.ApplicationLoadBalancer;

  private userPool: cognito.IUserPool;

  private userPoolDomain: cognito.IUserPoolDomain;

  private listener: elbv2.ApplicationListener;

  private zone: route53.IHostedZone;

  private baseDomainName: string;

  private priorityNumber: number = 1;

  constructor(scope: cdk.Construct, id: string, props: MLOpsRayStackProps) {
    super(scope, id, props);

    this.baseDomainName = ssm.StringParameter.valueForStringParameter(this, 'mlops-domain-name');
    const zoneId = ssm.StringParameter.valueForStringParameter(this, 'mlops-zone-id');
    const certificateArn = ssm.StringParameter.valueForStringParameter(this, 'mlops-cert-arn');

    // get the UserPool Id from export value
    this.userPool = cognito.UserPool.fromUserPoolId(this, "UserPool", cdk.Fn.importValue("MLOpsCognitoUserPoolId"));

    // get the User Pool Domain Name
    this.userPoolDomain = cognito.UserPoolDomain.fromDomainName(this, "UserPoolDomain", cdk.Fn.importValue("MLOpsCognitoUserPoolDomain"));

    // Create the ALB
    this.lb = new elbv2.ApplicationLoadBalancer(this, "ApplicationLoadBalancer", {
        internetFacing: true,
        vpc: props.vpc,
        securityGroup: props.albSecurityGroup,
    });

    // create a redirect from 80 to 443
    this.lb.addRedirect();

    // Load the Certificate for HTTPS
    const certificate = acm.Certificate.fromCertificateArn(this, 'AcmCertificate', certificateArn);        
    
    // Create the listeners
    this.listener = this.lb.addListener('AlbListener', {
        port: 443,
        open: true,
        certificates: [certificate],
        defaultAction: elbv2.ListenerAction.fixedResponse(200, {
          contentType: "text/plain",
          messageBody: 'OK',
        }),
    });

    // Create the Route 53 DNS entries
    this.zone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      zoneName: this.baseDomainName,
      hostedZoneId: zoneId,
    });

    // create the MLOps applictions
    const mlflowTargetGroup = this._createMlopsApplication(MlopsApps.MLFLOW, props.vpc, MlOpsPorts.MLFLOW, { healthyThresholdCount: 2 });
    const tensorboardTargetGroup = this._createMlopsApplication(MlopsApps.TENSORBOARD, props.vpc, MlOpsPorts.TENSORBOARD, { healthyThresholdCount: 2 });
    const dashboardTargetGroup = this._createMlopsApplication(MlopsApps.DASHBOARD, props.vpc, MlOpsPorts.DASHBOARD, { healthyThresholdCount: 2 });
    const jupyterTargetGroup = this._createMlopsApplication(MlopsApps.JUPYTER, props.vpc, MlOpsPorts.JUPYTER, { healthyThresholdCount: 2, path: "/tree?" });  
    const prometheusTargetGroup = this._createMlopsApplication(MlopsApps.PROMETHEUS, props.vpc, MlOpsPorts.PROMETHEUS, { healthyThresholdCount: 2, path: "/graph" });   

    // Create the Lambda function to register the instance
    const fn = new lambda.Function(this, 'MyLambda', {
        code: lambda.Code.fromAsset(path.join(__dirname, "..", 'lambda', 'ec2-event-processor')),
        handler: 'handler.lambda_handler',
        runtime: lambda.Runtime.PYTHON_3_7,
        environment: {
            MLFLOW_TARGET_GROUP_ARN: mlflowTargetGroup.targetGroupArn,
            TENSORBOARD_TARGET_GROUP_ARN: tensorboardTargetGroup.targetGroupArn,
            RAY_DASHBOARD_TARGET_GROUP_ARN: dashboardTargetGroup.targetGroupArn,
            JUPYTER_TARGET_GROUP_ARN: jupyterTargetGroup.targetGroupArn,
            PROMETHEUS_TARGET_GROUP_ARN: prometheusTargetGroup.targetGroupArn,
        }
    });

    // Add statements to Lambda function role
    fn.role?.addToPrincipalPolicy(new iam.PolicyStatement({
        resources: ['*'],
        actions: ['ec2:DescribeInstances']
    }));
    fn.role?.addToPrincipalPolicy(new iam.PolicyStatement({
        resources: [ 
          mlflowTargetGroup.targetGroupArn, 
          tensorboardTargetGroup.targetGroupArn, 
          dashboardTargetGroup.targetGroupArn, 
          jupyterTargetGroup.targetGroupArn, 
          prometheusTargetGroup.targetGroupArn, 
        ],
        actions: [ 'elasticloadbalancing:DeregisterTargets', 'elasticloadbalancing:RegisterTargets' ]
      }
    ));

    // create an event bridge rule to receive EC2 instance state notifications
    const rule = new events.Rule(this, 'rule', {
        eventPattern: {
            source: ["aws.ec2"],
            detailType: ["EC2 Instance State-change Notification"],
        },
    });
      
    // add the Lambda funtion as a target for the Event Bridge rule
    rule.addTarget(new targets.LambdaFunction(fn, {
        maxEventAge: cdk.Duration.hours(2), // Optional: set the maxEventAge retry policy
        retryAttempts: 2, // Optional: set the max number of retry attempts
    }));      

    new cdk.CfnOutput(this, "AlbDnsNameOutput", {
      value: this.lb.loadBalancerDnsName,
    }); 
  }

  /**
   * Create the MLOps application
   * 
   * @param name - the name of the MLOps application 
   * @param port - the port of the MLOps application
   * @param healthCheck - the healthcheck config
   * @returns the ALB Target Group
   */
  private _createMlopsApplication(name: string, vpc: ec2.IVpc, port: number, healthCheck?: elbv2.HealthCheck) {

    let domainName = name + '.' + this.baseDomainName;

    // Create Cognito User Pool clients for each endpoint
    let userPoolClient = new cognito.UserPoolClient(this, name + 'UserPoolClient', {
      userPool: this.userPool,
      userPoolClientName: name + "UserPoolClient",
      authFlows: {
        userPassword: true
      },
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
        },
        scopes: [ cognito.OAuthScope.EMAIL, cognito.OAuthScope.OPENID, cognito.OAuthScope.PROFILE, cognito.OAuthScope.COGNITO_ADMIN ],
        callbackUrls: [ 'https://' + domainName + '/oauth2/idpresponse' ]
      },
      supportedIdentityProviders: [ cognito.UserPoolClientIdentityProvider.COGNITO ],
      refreshTokenValidity: cdk.Duration.days(1),
      generateSecret: true,
    });

    // Create the ALB Listeners
    let targetGroup = new elbv2.ApplicationTargetGroup(this, name + "TargetGroup", {
        port,
        vpc,
        targetType: elbv2.TargetType.INSTANCE,
        protocol: elbv2.ApplicationProtocol.HTTP,
        healthCheck,        
    });

    // Create an action per application
    this.listener.addAction(name + 'Action', {
      priority: this.priorityNumber++,
      conditions: [
        elbv2.ListenerCondition.hostHeaders([domainName])
      ],
      action: new actions.AuthenticateCognitoAction({
        userPool: this.userPool,
        userPoolClient: userPoolClient,
        userPoolDomain: this.userPoolDomain,
        next: elbv2.ListenerAction.forward([targetGroup]),
      }),
    });

    // Create the CNAME DNS record
    new route53.CnameRecord(this, name + "CnameRecord", {
      zone: this.zone,
      recordName: domainName,
      domainName: this.lb.loadBalancerDnsName,
    });

    // return the target group
    return targetGroup;
  }
}

/**
 * The ports for each MLOps application.
 */
 export enum MlOpsPorts {

  MLFLOW = 5000,

  JUPYTER = 8888,

  TENSORBOARD = 6006,

  DASHBOARD = 8265,

  PROMETHEUS = 9090,

};

/**
 * The names of each MLOps application.
 */
export enum MlopsApps {

  MLFLOW = "mlflow",

  JUPYTER = "jupyter",

  TENSORBOARD = "tensorboard",

  DASHBOARD = "dashboard", 

  PROMETHEUS = "prometheus",

};