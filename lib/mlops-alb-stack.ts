#!/usr/bin/env node
import * as cdk from '@aws-cdk/core';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as events from '@aws-cdk/aws-events';
import * as targets from '@aws-cdk/aws-events-targets';
import * as lambda from '@aws-cdk/aws-lambda';
import * as elbv2 from '@aws-cdk/aws-elasticloadbalancingv2';
import * as cognito from '@aws-cdk/aws-cognito';
import * as acm from '@aws-cdk/aws-certificatemanager';

import { join } from "path";


export interface MLOpsAlbStackProps extends cdk.StackProps {
  
    vpc: ec2.IVpc;

    baseDomainName: string;

    certificateArn: string;
  
    hostedZoneId: string;

}

export class MLOpsAlbStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props: MLOpsAlbStackProps) {
    super(scope, id, props);

    // get the cognito info 
    const cognitoUserPoolArn = cdk.Fn.importValue("CognitoUserPoolArn");
    const userPool = cognito.UserPool.fromUserPoolId(this, "UserPool", cdk.Fn.importValue("CognitoUserPoolId"));
    const cognitoUserPoolDomain = cdk.Fn.importValue("CognitoUserPoolDomainName")

    // Create the ALB
    const lb = new elbv2.ApplicationLoadBalancer(this, "ApplicationLoadBalancer", {
        internetFacing: true,
        vpc: props.vpc,
    });
    // allow the ALB to call out to the Cognito service
    lb.connections.allowToAnyIpv4(ec2.Port.tcp(443));

    // Create the ALB Listeners
    const mlflowTargetGroup = new elbv2.ApplicationTargetGroup(this, "MlflowTargetGroup", {
        port: 5000,
        vpc: props.vpc,
        targetType: elbv2.TargetType.INSTANCE,
    });
    const tensorboardTargetGroup = new elbv2.ApplicationTargetGroup(this, "TensorboardTargetGroup", {
        port: 6006,
        vpc: props.vpc,
        targetType: elbv2.TargetType.INSTANCE,
    });
    const dashboardTargetGroup = new elbv2.ApplicationTargetGroup(this, "DashboardTargetGroup", {
        port: 8265,
        vpc: props.vpc,
        targetType: elbv2.TargetType.INSTANCE,
    });
    const jupyterTargetGroup = new elbv2.ApplicationTargetGroup(this, "JupyterTargetGroup", {
        port: 8888,
        vpc: props.vpc,
        targetType: elbv2.TargetType.INSTANCE,
    });            

    // Load the Certificate for HTTPS
    const certificate = acm.Certificate.fromCertificateArn(this, 'Certificate', props.certificateArn);    

    // Create the listeners
    const listener = lb.addListener('Listener', {
        port: 443,
        open: true,
        certificates: [certificate],
    });

    listener.addAction('MLFlow Action', {
        conditions: [
            elbv2.ListenerCondition.hostHeaders(['mlflow.ml.hyper-ski.com'])
        ],
        action: elbv2.ListenerAction.authenticateOidc({

        })
    })

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
  }
}