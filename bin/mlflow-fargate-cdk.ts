#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';

import { MlflowFargateBaseStack } from '../lib/mlflow-fargate-base-stack';
import { MlflowFargateAlbStack } from '../lib/mlflow-fargate-alb-stack';

const app = new cdk.App();

if (process.env.REGION == undefined || process.env.ACCOUNT_ID == undefined) {
  throw new Error("Environment variable REGION or ACCOUNT_ID missing");
}

const env = { 
  region: process.env.REGION,
  account: process.env.ACCOUNT_ID,
};
 
const baseDomainName = "ml.hyper-ski.com";

const baseStack = new MlflowFargateBaseStack(app, 'MLOps-BaseStack', { 
  domainName: baseDomainName, 
  env,
});

const albStack = new MlflowFargateAlbStack(app, 'MLOps-AlbStack', {
  vpc: baseStack.vpc,
  cluster: baseStack.cluster,
  s3Bucket: baseStack.s3Bucket,
  efsFileSystem: baseStack.efsFileSystem,
  efsSecurityGroup: baseStack.sourceEfsSecurityGroup,
  hostedZoneId: "Z0827235J20SOQKXZ8F6",
  certificateArn: "arn:aws:acm:eu-west-1:135929256640:certificate/cbe399f7-2e7a-4cae-a339-0958fab05880",
  baseDomainName,
  serviceName: "mlflow",
  env,    
});

albStack.addDependency(baseStack);