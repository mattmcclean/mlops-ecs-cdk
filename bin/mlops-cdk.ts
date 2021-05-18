#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';

import { MLOpsRayStack } from '../lib/mlops-ray-stack';

const app = new cdk.App();

if (process.env.REGION == undefined || process.env.ACCOUNT_ID == undefined) {
  throw new Error("Environment variable REGION or ACCOUNT_ID missing");
}

const env = { 
  region: process.env.REGION,
  account: process.env.ACCOUNT_ID,
};

const rayStack = new MLOpsRayStack(app, 'MLOps-Ray-Stack', { env });
