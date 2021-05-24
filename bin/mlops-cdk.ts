#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';

import { MLOpsRayStack } from '../lib/mlops-ray-stack';
import { MLOpsBaseStack } from '../lib/mlops-base-stack';
import { MLOpsRdsStack } from '../lib/mlops-rds-stack';

const app = new cdk.App();

if (process.env.REGION == undefined || process.env.ACCOUNT_ID == undefined) {
  throw new Error("Environment variable REGION or ACCOUNT_ID missing");
}

const env = { 
  region: process.env.REGION,
  account: process.env.ACCOUNT_ID,
};

const baseStack = new MLOpsBaseStack(app, "MLOps-Base-Stack", { env });

const rayStack = new MLOpsRayStack(app, 'MLOps-Ray-Stack', { 
  vpc: baseStack.vpc,
  raySecurityGroup: baseStack.raySecurityGroup,
  albSecurityGroup: baseStack.albSecurityGroup,
  env, 
});

rayStack.addDependency(baseStack);

const rdsStack = new MLOpsRdsStack(app, "MLOps-Rds-Stack", { 
  env, 
  vpc: baseStack.vpc,
  sourceSg: baseStack.raySecurityGroup,
});

rdsStack.addDependency(baseStack);